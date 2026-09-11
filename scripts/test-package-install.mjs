#!/usr/bin/env node
// Test a built archive, never a symlink to the developer checkout. No live API calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  existsSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const input = process.argv[2] || '';
const isGit = /^github:hs3180\/disclaude#[a-f0-9]{40}$/.test(input);
const archive = isGit ? input : resolve(input);
assert(
  isGit || (input.endsWith('.tgz') && existsSync(archive)),
  'Pass a .tgz or github:hs3180/disclaude#<full SHA>'
);
const temp = mkdtempSync(join(tmpdir(), 'disclaude-package-test-'));
const prefix = join(temp, 'prefix');
const env = { ...process.env, NODE_ENV: 'production' };
const config = join(temp, 'smoke.json');
writeFileSync(
  config,
  JSON.stringify({
    agent: { agentBackend: 'claude', provider: 'anthropic', model: 'claude-sonnet-4' },
    anthropic: { apiKey: 'offline-test-placeholder' },
    workspace: { dir: temp },
    channels: { feishu: { enabled: false } },
    logging: { level: 'silent' },
  })
);
env.DISCLAUDE_CONFIG_PATH = config;
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
for (const key of Object.keys(env)) {
  if (/^npm_config_/i.test(key)) delete env[key];
}
const prefixFromEnv = process.argv.includes('--prefix-from-env');
if (prefixFromEnv) env.npm_config_prefix = prefix;
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: temp,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}
console.log(`Isolated installation evidence: ${temp}`);
console.log(
  `Runtime: ${process.version}; npm: ${run('npm', ['--version']).trim()}; input: ${archive}`
);
run('npm', [
  'install',
  '-g',
  ...(prefixFromEnv ? [] : ['--prefix', prefix]),
  '--cache',
  join(temp, 'cache'),
  '--userconfig',
  join(temp, 'empty.npmrc'),
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  archive,
]);
const installed = join(prefix, 'lib/node_modules/disclaude');
assert(
  realpathSync(installed).startsWith(realpathSync(prefix) + sep),
  'Package must not link to a temporary clone'
);
const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
assert.equal(pkg.scripts?.prepare, undefined, 'User installation must not initialize Git hooks');
if (isGit) {
  assert.equal(pkg.workspaces, undefined);
  for (const script of ['build', 'prepack', 'preinstall', 'install', 'postinstall'])
    assert.equal(pkg.scripts?.[script], undefined);
  assert(existsSync(join(installed, 'release-source.json')));
  assert(existsSync(join(installed, '.claude-plugin/plugin.json')));
  assert(existsSync(join(installed, 'agents/mac-screen-control.md')));
  if (process.argv[3] && !process.argv[3].startsWith('--'))
    assert.equal(
      JSON.parse(readFileSync(join(installed, 'release-source.json'), 'utf8')).sourceFingerprint,
      process.argv[3],
      'Installed candidate provenance mismatch'
    );
}
assert(!existsSync(join(installed, 'node_modules/husky')), 'Husky must remain development-only');
assert(existsSync(join(installed, 'disclaude.config.example.yaml')));
const cli = join(prefix, 'bin/disclaude');
assert.equal(run(cli, ['--version']).trim(), `disclaude v${pkg.version}`);
assert.match(run(cli, ['start', '--help']), /Usage:/i);
assert.match(run(cli, ['channel', '--help']), /Usage:/i);
assert.match(run(join(prefix, 'bin/disclaude'), ['--help']), /Usage:/i);
assert.deepEqual(Object.keys(pkg.bin), ['disclaude']);
assert(!existsSync(join(installed, 'packages/primary-node')));
assert(!existsSync(join(installed, 'node_modules/@disclaude/primary-node')));
assert(!existsSync(join(prefix, 'bin/disclaude-primary')));
assert(!existsSync(join(prefix, 'bin/disclaude-service')));
// Loading the installed modules catches missing transitive SDK dependencies that
// --version alone cannot detect. Resolve relative to the installed distribution.
run(process.execPath, [
  '--input-type=module',
  '-e',
  `
  import { join } from 'node:path';
  import { realpathSync } from 'node:fs';
  import { pathToFileURL } from 'node:url';
  const installed = ${JSON.stringify(installed)};
  const modulesRoot = ${JSON.stringify(isGit ? 'packages' : 'node_modules/@disclaude')};
  const load = (name, file = 'index.js') => import(pathToFileURL(join(installed, modulesRoot, name, 'dist', file)).href);
  for (const name of ['core', 'service', 'channel-cli']) {
    await load(name);
  }
  const { DisclaudeService } = await load('service', 'service.js');
  const { Config } = await load('core');
  if (${isGit} && realpathSync(Config.getBuiltinsDir()) !== realpathSync(installed)) throw new Error('Builtins do not resolve to installed release');
  const service = new DisclaudeService();
  await service.start({ deferScheduler: true });
  if (!service.isRunning()) throw new Error('DisclaudeService did not start');
  await service.stop();
  if (service.isRunning()) throw new Error('DisclaudeService did not stop');
  process.exit(0);
`,
]);
// Exercise the public executable twice with isolated data and loopback-only REST.
// No model prompt, live channel or production service is touched.
const portProbe = createServer();
await new Promise((done) => portProbe.listen(0, '127.0.0.1', done));
const restPort = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const cliConfig = JSON.parse(readFileSync(config, 'utf8'));
cliConfig.channels.rest = { port: restPort, host: '127.0.0.1', fileStorageDir: join(temp, 'files') };
writeFileSync(config, JSON.stringify(cliConfig));
const sentinel = join(temp, 'user-data.txt');
writeFileSync(sentinel, 'preserved across restart');
for (let attempt = 0; attempt < 2; attempt++) {
  let output = '';
  const child = spawn(cli, ['start', '--config', config, '--api-port', '0'], {
    cwd: temp, env: { ...env, LOCKFILE_PATH: join(temp, 'service.pid') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let childError;
  child.on('error', (error) => { childError = error; });
  const exited = new Promise((done) => child.once('close', (code) => done(code)));
  try {
    let baseUrl;
    for (let i = 0; i < 150; i++) {
      baseUrl = output.match(/HTTP API server started on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (baseUrl || childError || child.exitCode !== null) break;
      await delay(100);
    }
    assert(baseUrl, `CLI failed to start: ${childError || ''}\n${output}`);
    const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.status, 'ok');
    assert.equal(typeof status.instanceId, 'string');
    assert.equal(status.nodeId, undefined);
    child.kill('SIGTERM');
    assert.equal(await Promise.race([exited, delay(15000).then(() => 'timeout')]), 0, output);
    assert(!existsSync(join(temp, 'service.pid')), 'Graceful shutdown must release the instance lock');
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserved across restart');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      // Only this test's wrapper and its child are in scope.
      child.kill('SIGTERM');
    }
  }
}
console.log(`CLI_START_STOP_RESTART_OK ${pkg.version}`);
console.log(`PACKAGE_INSTALL_OK ${pkg.version}`);
// Only discard this run's generated installation/cache; retain failures for diagnosis.
rmSync(prefix, { recursive: true });
rmSync(join(temp, 'cache'), { recursive: true });
