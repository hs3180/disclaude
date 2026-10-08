#!/usr/bin/env node
/** Generate and deploy the pinned upstream Jupyter/nbmodel repair from disclaude. */
import { createHash } from 'node:crypto';
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
    'install.py',
    'configure.py',
    'discovery.py',
    'environment.py',
    'manifest.json',
    'runtime.py',
    'server-config.json',
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
  generate   Export the same repair artifact and SHA-256 (--output FILE)
  prepare    Stage verified originals and patched files through Jupyter Terminal
  apply      Install the prepared files; restart Jupyter externally to activate
  rollback   Restore saved original files; restart Jupyter externally to activate
  status     Inspect saved installation state and file fingerprints

Options:
  --jupyter URL       Jupyter endpoint (or 'configured')
  --env-file FILE     Host-private .env (default: .env in the current directory)
  --password-env NAME Password environment key (default: JUPYTERLAB_PASS)
  --token-env NAME    API token environment key (default: JUPYTERLAB_TOKEN)
  --interactive       Enter credentials even when already configured; no secret echo
  --no-interactive    Require configured credentials; never prompt (for scripts)
  --python PATH       Jupyter Server Python when ancestry discovery is ambiguous
  --config-file PATH  Target .py/.json config; default uses Jupyter search paths
  --frontend-dir PATH Select a Lab bundle when discovery is ambiguous
  --state-dir PATH    Absolute Jupyter-side state directory; retain for rollback
  --output FILE       Local artifact path, only for generate

Generation uses Node only. Installation uses authenticated Jupyter Terminal
and the Server's existing Python 3.9+ environment.
Authentication: environment > .env > prompts for missing values in a TTY.
Password wins over token in the same source; --token-env selects token explicitly.
Installation changes files on disk. Running Server code is not hot-reloaded.
Save notebooks, close kernels and restart with the existing deployment manager,
then refresh Lab. The CLI does not control the Server's lifecycle.`);
}

function parse(args) {
  if (args[0] !== 'patch') throw new Error("Use 'disclaude jupyter patch --help'");
  const options = { action: args[1] };
  if (!['info', 'generate', 'prepare', 'apply', 'rollback', 'status'].includes(options.action))
    throw new Error('Expected info, generate, prepare, apply, rollback or status');
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (['--interactive', '--no-interactive'].includes(key)) {
      if (Object.hasOwn(options, 'interactive')) throw new Error('Choose one interactive option');
      options.interactive = key === '--interactive';
      continue;
    }
    if (key === '--hot') throw new Error('Hot activation is unavailable for this Jupyter repair');
    const property = {
      '--jupyter': 'jupyter',
      '--env-file': 'envFile',
      '--password-env': 'passwordEnv',
      '--token-env': 'tokenEnv',
      '--python': 'python',
      '--config-file': 'configFile',
      '--frontend-dir': 'frontendDir',
      '--state-dir': 'stateDir',
      '--output': 'output',
    }[key];
    if (typeof property !== 'string' || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Unknown option or missing value: ' + key);
    if (Object.hasOwn(options, property)) throw new Error('Repeated option: ' + key);
    options[property] = args[++i];
  }
  if (options.python && (/[\0\r\n]/.test(options.python) || options.python.startsWith('-')))
    throw new Error('Invalid target Python executable');
  for (const property of ['stateDir', 'configFile', 'frontendDir'])
    if (
      options[property] &&
      (!options[property].startsWith('/') || /[\0\r\n]/.test(options[property]))
    )
      throw new Error('Target paths must be absolute');
  const deploymentOptions = [
    'jupyter',
    'envFile',
    'passwordEnv',
    'tokenEnv',
    'interactive',
    'python',
    'configFile',
    'frontendDir',
    'stateDir',
  ];
  if (options.action === 'generate') {
    if (!options.output || deploymentOptions.some((key) => Object.hasOwn(options, key)))
      throw new Error('generate requires --output FILE and no deployment options');
  } else if (options.output) throw new Error('--output is only for generate');
  if (options.action === 'info') {
    if (deploymentOptions.some((key) => Object.hasOwn(options, key)))
      throw new Error('info does not use deployment options');
  } else if (options.action !== 'generate') {
    options.jupyter ||= 'configured';
    for (const key of ['passwordEnv', 'tokenEnv'])
      if (options[key] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options[key]))
        throw new Error('Invalid credential environment key');
    if (options.passwordEnv && options.tokenEnv)
      throw new Error('Choose password or token authentication');
  }
  return options;
}

export function terminalArguments(options) {
  const forwarded = [options.action];
  for (const [property, key] of [
    ['configFile', '--config-file'],
    ['frontendDir', '--frontend-dir'],
    ['stateDir', '--state-dir'],
  ])
    if (options[property]) forwarded.push(key, options[property]);
  return forwarded;
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
  } else {
    const { deployTerminal } = await import('./jupyter-terminal.js');
    console.log(JSON.stringify(await deployTerminal(options, patch, terminalArguments(options))));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Jupyter patch refused: ' + error.message);
    process.exitCode = 1;
  });
}
