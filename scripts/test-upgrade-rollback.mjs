#!/usr/bin/env node
// Exercise one isolated prefix across a pinned upgrade and rollback; no live model/channel calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [baseline, candidate, fingerprint] = process.argv.slice(2);
for (const ref of [baseline, candidate]) assert(/^github:hs3180\/disclaude#[a-f0-9]{40}$/.test(ref || ''), 'Pinned distribution SHA required');
const temp = mkdtempSync(join(tmpdir(), 'disclaude-upgrade-rollback-'));
const prefix = join(temp, 'prefix');
const workspace = join(temp, 'workspace');
mkdirSync(workspace);
const portProbe = createServer();
await new Promise(done => portProbe.listen(0, '127.0.0.1', done));
const restPort = portProbe.address().port;
await new Promise(done => portProbe.close(done));
const configPath = join(temp, 'config.json');
const config = JSON.stringify({ agent: { agentBackend: 'claude', provider: 'anthropic', model: 'claude-sonnet-4' },
  anthropic: { apiKey: 'offline-test-placeholder' }, workspace: { dir: workspace },
  channels: { feishu: { enabled: false }, rest: { port: restPort, host: '127.0.0.1', fileStorageDir: join(workspace, 'files') } },
  logging: { level: 'silent' } });
const preserved = new Map([[configPath, config], [join(workspace, 'user-data.txt'), 'preserved user data'],
  [join(workspace, '.runtime-env'), 'ACCEPTANCE_CREDENTIAL=synthetic-upgrade-fixture\n']]);
for (const [file, content] of preserved) writeFileSync(file, content, { mode: 0o600 });
const env = { ...process.env, NODE_ENV: 'production', DISCLAUDE_CONFIG_PATH: configPath,
  LOCKFILE_PATH: join(temp, 'service.pid'), npm_config_cache: join(temp, 'cache'), npm_config_userconfig: join(temp, 'empty.npmrc') };
delete env.NODE_OPTIONS; delete env.NODE_PATH;
const verifyData = () => { for (const [file, content] of preserved) assert.equal(readFileSync(file, 'utf8'), content, file); };
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: temp, env, encoding: 'utf8', timeout: 240000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
console.log(`UPGRADE_RUNTIME ${process.version}; npm ${run('npm', ['--version']).trim()}`);
for (const [phase, ref] of [['baseline', baseline], ['upgrade', candidate], ['rollback', baseline]]) {
  run('npm', ['install', '-g', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', ref]);
  verifyData();
  const installed = join(prefix, 'lib/node_modules/disclaude');
  const provenance = JSON.parse(readFileSync(join(installed, 'release-source.json'), 'utf8'));
  if (phase === 'upgrade') assert.equal(provenance.sourceFingerprint, fingerprint);
  const cli = join(prefix, 'bin/disclaude');
  assert.equal(run(cli, ['--version']).trim(), `disclaude v${provenance.version}`);
  const child = spawn(cli, ['start', '--config', configPath, '--api-port', '0'], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    let url;
    for (let i = 0; i < 150; i++) {
      url = output.match(/HTTP API server started on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url || child.exitCode !== null) break;
      await delay(100);
    }
    assert(url, `CLI did not become healthy: ${output}`);
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
    child.kill('SIGTERM');
    assert.equal(await Promise.race([exited, delay(15000).then(() => 'timeout')]), 0, output);
    assert(!existsSync(env.LOCKFILE_PATH), 'Instance lock remains after stop');
    verifyData();
    console.log(`UPGRADE_PHASE_OK ${phase} ${provenance.version}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
console.log('UPGRADE_ROLLBACK_OK config/runtime-env/user-data preserved');
rmSync(temp, { recursive: true, force: true });
