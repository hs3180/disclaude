#!/usr/bin/env node
/** Generate and deploy the pinned upstream Jupyter/nbmodel repair from disclaude. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'jupyter/datalayer');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const activation = {
  hotApplySupported: false,
  serverRestartRequired: true,
  labRefreshRequired: true,
  kernelMemoryPreserved: false,
  reason:
    'This repair changes existing execution-stack state and queue workers; Jupyter has no migration hook for it.',
};

function readSource(source, name) {
  const path = resolve(source, name);
  const rel = relative(realpathSync(source), realpathSync(path));
  if (!lstatSync(path).isFile() || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
    throw new Error('Invalid Jupyter patch resource');
  }
  return readFileSync(path);
}

function refuseExisting(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Output already exists: ' + path);
}

// ZIP's CRC-32 and deflate format keep generation independent of host Python
// and external executables. Python's stdlib zipfile verifies this on the target.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildPatch(source = SOURCE) {
  const manifestBytes = readSource(source, 'manifest.json');
  const manifest = JSON.parse(manifestBytes);
  const names = [
    'Dockerfile',
    'install.py',
    'configure.py',
    'manifest.json',
    'runtime.py',
    'server-config.json',
    'reporting-requirements.txt',
    'LICENSE.nbmodel',
    'frontend-source.patch',
    ...manifest.changes.map((item) => item.patch),
  ];
  const files = new Map([
    ['__main__.py', Buffer.from('from deploy import main\nmain()\n')],
    ['deploy.py', readSource(source, 'deploy.py')],
    ...names.map((name) => ['payload/' + name, readSource(source, name)]),
  ]);
  const order = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  const index = {
    schema: 1,
    revision: manifest.revision,
    manifestSha256: sha(manifestBytes),
    files: Object.fromEntries([...files].sort(order).map(([name, data]) => [name, sha(data)])),
  };
  files.set('index.json', Buffer.from(JSON.stringify(index, null, 2) + '\n'));
  const prefix = Buffer.from('#!/usr/bin/env python3\n');
  const chunks = [prefix],
    directory = [];
  let offset = prefix.length;
  for (const [name, data] of [...files].sort(order)) {
    const encoded = Buffer.from(name),
      compressed = deflateRawSync(data, { level: 9 });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    header.copy(central, 6, 4, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    chunks.push(header, encoded, compressed);
    directory.push(central, encoded);
    offset += header.length + encoded.length + compressed.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return {
    bytes: Buffer.concat([...chunks, central, end]),
    revision: manifest.revision,
    manifestSha256: index.manifestSha256,
    activation,
  };
}

function help() {
  console.log(`Usage: disclaude jupyter patch <action> [options]

Actions:
  info       Show the upstream repair revision and activation requirements
  generate   Generate a Jupyter repair artifact and SHA-256 (--output FILE)
  prepare    Generate, transfer and prepare remotely; keep Jupyter running
  apply      Generate and deploy remotely (--restart required)
  rollback   Restore the saved original deployment (--restart required)
  status     Read the saved remote phase and current image

Options:
  --ssh HOST          Remote Docker host, e.g. mathlab@192.168.5.183
  --container NAME    Existing Compose container (default: jupyter-gpu-1)
  --state-dir PATH    Absolute remote state directory; retain it for rollback
  --restart           Recreate this Jupyter service; existing kernels end
  --output FILE       Local artifact path, only for generate

Generation uses Node only. Deployment uses remote Python 3.9+ and Docker Compose v2.
Save notebooks and close kernels before --restart; this repair cannot activate hot.`);
}

function parse(args) {
  if (args[0] !== 'patch') throw new Error("Use 'disclaude jupyter patch --help'");
  const options = { action: args[1], container: 'jupyter-gpu-1', restart: false };
  if (!['info', 'generate', 'prepare', 'apply', 'rollback', 'status'].includes(options.action)) {
    throw new Error('Expected info, generate, prepare, apply, rollback or status');
  }
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (key === '--restart') {
      options.restart = true;
      continue;
    }
    if (key === '--hot')
      throw new Error(
        'Hot activation is unavailable for this Jupyter repair; no service operation performed'
      );
    if (
      !['--ssh', '--container', '--state-dir', '--output'].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    ) {
      throw new Error('Unknown option or missing value: ' + key);
    }
    const property = {
      '--ssh': 'ssh',
      '--container': 'container',
      '--state-dir': 'stateDir',
      '--output': 'output',
    }[key];
    if (Object.hasOwn(options, property) && property !== 'container')
      throw new Error('Repeated option: ' + key);
    options[property] = args[++i];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.container))
    throw new Error('Invalid container name or ID');
  if (options.stateDir && !options.stateDir.startsWith('/'))
    throw new Error('--state-dir must be an absolute remote path');
  if (options.action === 'generate') {
    if (!options.output || options.ssh || options.restart || options.stateDir)
      throw new Error('generate requires --output FILE and no deployment options');
  } else if (options.output) throw new Error('--output is only for generate');
  if (options.action === 'info') {
    if (options.ssh || options.restart || options.stateDir)
      throw new Error('info does not use deployment options');
  } else if (options.action !== 'generate') {
    if (!options.ssh || !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.ssh))
      throw new Error(
        '--ssh requires a host or user@host (use SSH config aliases for custom ports/IPv6)'
      );
    if (['apply', 'rollback'].includes(options.action) && !options.restart)
      throw new Error(
        'Save/close kernels, then add --restart; no SSH or service operation performed'
      );
    if (!['apply', 'rollback'].includes(options.action) && options.restart)
      throw new Error('--restart is only for apply/rollback');
  }
  return options;
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function remoteCommand(options, digest) {
  const forwarded = [options.action, '--container', options.container];
  if (options.stateDir) forwarded.push('--state-dir', options.stateDir);
  if (options.restart) forwarded.push('--restart');
  // Artifact bytes travel on stdin; deployment configuration and credentials
  // never enter them. Do not retry an SSH failure after an unknown switch result.
  const code = `import hashlib, os, pathlib, sys, tempfile
data = sys.stdin.buffer.read()
expected = ${JSON.stringify(digest)}
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit('Jupyter patch transfer checksum differs')
root = pathlib.Path.home() / '.local/share/disclaude/jupyter-patches' / expected
root.mkdir(parents=True, exist_ok=True)
if root.is_symlink():
    raise SystemExit('Refuse a symlinked patch directory')
root.chmod(0o700)
artifact = root / 'nbmodel-repair.pyz'
if artifact.exists() or artifact.is_symlink():
    if artifact.is_symlink() or not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != expected:
        raise SystemExit('Existing Jupyter patch artifact differs')
else:
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as stream:
        temporary = pathlib.Path(stream.name)
        stream.write(data)
    temporary.chmod(0o600)
    temporary.replace(artifact)
os.execv(sys.executable, [sys.executable, str(artifact)] + ${JSON.stringify(forwarded)})
`;
  return 'python3 -c ' + quote(code);
}

async function deployRemote(options, patch) {
  const child = spawn(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '--',
      options.ssh,
      remoteCommand(options, sha(patch.bytes)),
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
  // A failed connection may close stdin early; its exit/error remains authoritative.
  child.stdin.on('error', () => {});
  child.stdin.end(patch.bytes);
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT'),
    terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (code) =>
        code === 0
          ? done()
          : fail(
              new Error(`SSH patch command failed (exit ${code}); inspect status before any retry`)
            )
      );
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  const options = parse(args),
    patch = buildPatch();
  if (options.action === 'info') {
    console.log(
      JSON.stringify({
        target: 'jupyter_server_nbmodel',
        revision: patch.revision,
        manifestSha256: patch.manifestSha256,
        activation,
      })
    );
  } else if (options.action === 'generate') {
    const target = resolve(options.output),
      digest = sha(patch.bytes);
    refuseExisting(target);
    refuseExisting(target + '.sha256');
    mkdirSync(dirname(target), { recursive: true });
    // Refuse existing user files; deployment generates and transfers in memory.
    writeFileSync(target, patch.bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(target + '.sha256', digest + '  ' + basename(target) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        artifact: target,
        sha256: digest,
        bytes: patch.bytes.length,
        revision: patch.revision,
        manifestSha256: patch.manifestSha256,
        activation,
      })
    );
  } else await deployRemote(options, patch);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Jupyter patch refused: ' + error.message);
    process.exitCode = 1;
  });
}
