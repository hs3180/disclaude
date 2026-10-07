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
    'discovery.py',
    'environment.py',
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
  status     Read the saved phase and observed deployment

Options:
  --ssh HOST          Remote host or SSH config alias
  --jupyter URL       Use Jupyter Terminal for prepare/status (or 'configured')
  --env-file FILE     Host-private .env for JUPYTERLAB_HOST/JUPYTERLAB_PASS
  --password-env NAME Password environment key (default: JUPYTERLAB_PASS)
  --token-env NAME    Use an API token environment key instead of password
  --python PATH       Target Jupyter Python (default: python3); venv/conda supported
  --container NAME    Select an existing Compose container instead of plain Python
  --config-file PATH  Target .py/.json config; default uses Jupyter search paths
  --frontend-dir PATH Select a Lab bundle when discovery is ambiguous
  --service UNIT      Existing systemd .service for plain-environment stop/start
  --system            Use system systemd rather than user systemd
  --state-dir PATH    Absolute remote state directory; retain it for rollback
  --restart           Restart the selected Compose/systemd service
  --stopped           Apply to an externally stopped plain Python deployment
  --output FILE       Local artifact path, only for generate

Generation uses Node only. Deployment uses the selected remote Python 3.9+.
Docker Compose v2 is needed only with --container; there is no default container.
Terminal uses the existing Jupyter login and needs no SSH. Stop/restart is external.
Save notebooks and close kernels before --restart; this repair cannot activate hot.`);
}

function parse(args) {
  if (args[0] !== 'patch') throw new Error("Use 'disclaude jupyter patch --help'");
  const options = { action: args[1] };
  if (!['info', 'generate', 'prepare', 'apply', 'rollback', 'status'].includes(options.action)) {
    throw new Error('Expected info, generate, prepare, apply, rollback or status');
  }
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (['--restart', '--stopped', '--system'].includes(key)) {
      const property = key.slice(2);
      if (Object.hasOwn(options, property)) throw new Error('Repeated option: ' + key);
      options[property] = true;
      continue;
    }
    if (key === '--hot')
      throw new Error(
        'Hot activation is unavailable for this Jupyter repair; no service operation performed'
      );
    if (
      ![
        '--ssh',
        '--jupyter',
        '--env-file',
        '--password-env',
        '--token-env',
        '--container',
        '--python',
        '--config-file',
        '--frontend-dir',
        '--service',
        '--state-dir',
        '--output',
      ].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    ) {
      throw new Error('Unknown option or missing value: ' + key);
    }
    const property = {
      '--ssh': 'ssh',
      '--jupyter': 'jupyter',
      '--env-file': 'envFile',
      '--password-env': 'passwordEnv',
      '--token-env': 'tokenEnv',
      '--container': 'container',
      '--python': 'python',
      '--config-file': 'configFile',
      '--frontend-dir': 'frontendDir',
      '--service': 'service',
      '--state-dir': 'stateDir',
      '--output': 'output',
    }[key];
    if (Object.hasOwn(options, property)) throw new Error('Repeated option: ' + key);
    options[property] = args[++i];
  }
  if (options.container && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.container))
    throw new Error('Invalid container name or ID');
  if (options.python && (/[\0\r\n]/.test(options.python) || options.python.startsWith('-')))
    throw new Error('Invalid target Python executable');
  for (const property of ['stateDir', 'configFile', 'frontendDir']) {
    if (
      options[property] &&
      (!options[property].startsWith('/') || /[\0\r\n]/.test(options[property]))
    )
      throw new Error('Target paths must be absolute');
  }
  if (options.service && !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(options.service))
    throw new Error('Expected a systemd .service unit name');
  if (
    (options.container && (options.service || options.system || options.stopped)) ||
    (options.system && !options.service)
  )
    throw new Error('Service/stopped options target plain Python; --system requires --service');
  if (options.restart && options.stopped) throw new Error('Choose --restart or --stopped');
  const deploymentOptions = [
    'ssh',
    'jupyter',
    'envFile',
    'passwordEnv',
    'tokenEnv',
    'container',
    'python',
    'configFile',
    'frontendDir',
    'service',
    'stateDir',
    'restart',
    'stopped',
    'system',
  ];
  if (options.action === 'generate') {
    if (!options.output || deploymentOptions.some((key) => Object.hasOwn(options, key)))
      throw new Error('generate requires --output FILE and no deployment options');
  } else if (options.output) throw new Error('--output is only for generate');
  if (options.action === 'info') {
    if (deploymentOptions.some((key) => Object.hasOwn(options, key)))
      throw new Error('info does not use deployment options');
  } else if (options.action !== 'generate') {
    if (!!options.ssh === !!options.jupyter) throw new Error('Choose --jupyter URL or --ssh HOST');
    for (const key of ['passwordEnv', 'tokenEnv']) {
      if (options[key] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options[key]))
        throw new Error('Invalid credential environment key');
    }
    if (options.passwordEnv && options.tokenEnv)
      throw new Error('Choose password or token authentication');
    if (
      options.jupyter &&
      (!['prepare', 'status'].includes(options.action) ||
        options.container ||
        options.service ||
        options.system ||
        options.restart ||
        options.stopped)
    )
      throw new Error(
        'Jupyter Terminal supports prepare/status; apply/rollback requires an external stop/restart channel'
      );
    if (!options.jupyter && (options.envFile || options.passwordEnv || options.tokenEnv))
      throw new Error('Jupyter authentication options require --jupyter');
    if (options.ssh && !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.ssh))
      throw new Error(
        '--ssh requires a host or user@host (use SSH config aliases for custom ports/IPv6)'
      );
    if (
      ['apply', 'rollback'].includes(options.action) &&
      !(
        (options.container && options.restart) ||
        (!options.container &&
          ((options.service && options.restart) || (!options.service && options.stopped)))
      )
    )
      throw new Error(
        'Use --container/--service with --restart, or stop Jupyter externally and use --stopped; no SSH or service operation performed'
      );
    if (!['apply', 'rollback'].includes(options.action) && (options.restart || options.stopped))
      throw new Error('--restart/--stopped is only for apply/rollback');
  }
  return options;
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function remoteArguments(options) {
  const forwarded = [options.action];
  for (const [property, key] of [
    ['container', '--container'],
    ['configFile', '--config-file'],
    ['frontendDir', '--frontend-dir'],
    ['service', '--service'],
    ['stateDir', '--state-dir'],
  ]) {
    if (options[property]) forwarded.push(key, options[property]);
  }
  if (options.container && options.python) forwarded.push('--python', options.python);
  for (const key of ['restart', 'stopped', 'system']) if (options[key]) forwarded.push('--' + key);
  return forwarded;
}

export function remoteCommand(options, digest) {
  const forwarded = remoteArguments(options);
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
  return quote(options.container ? 'python3' : options.python || 'python3') + ' -c ' + quote(code);
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
  } else if (options.jupyter) {
    const { deployTerminal } = await import('./jupyter-terminal.js');
    console.log(JSON.stringify(await deployTerminal(options, patch, remoteArguments(options))));
  } else await deployRemote(options, patch);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Jupyter patch refused: ' + error.message);
    process.exitCode = 1;
  });
}
