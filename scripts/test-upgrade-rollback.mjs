#!/usr/bin/env node
// Exercise one isolated prefix across a pinned upgrade and rollback; no live model/channel calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2).filter(arg => arg !== '--keep-temp');
assert(args.length === 3 || args.length === 4,
  'Usage: test-upgrade-rollback.mjs <baseline SHA ref or .tgz> <candidate SHA ref or .tgz> <candidate fingerprint> [baseline fingerprint] [--keep-temp]');
const [baselineInput, candidateInput, fingerprint, baselineFingerprint] = args;
assert(/^[a-f0-9]{64}$/.test(fingerprint), 'Candidate source fingerprint required');
if (baselineFingerprint !== undefined) assert(/^[a-f0-9]{64}$/.test(baselineFingerprint), 'Invalid baseline fingerprint');
const archiveOrRef = value => {
  if (/^github:hs3180\/disclaude#[a-f0-9]{40}$/.test(value)) return value;
  assert(value.endsWith('.tgz') && existsSync(value) && statSync(value).isFile(), 'Pinned distribution SHA or existing .tgz required');
  assert(baselineFingerprint, 'Local archive verification requires the baseline fingerprint too');
  return resolve(value);
};
const baseline = archiveOrRef(baselineInput);
const candidate = archiveOrRef(candidateInput);
const temp = mkdtempSync(join(tmpdir(), 'disclaude-upgrade-rollback-'));
let cleanupSafe = true;
console.log(`Isolated upgrade evidence: ${temp}`);
async function verifyUpgrade() {
  const prefix = join(temp, 'prefix');
  const workspace = join(temp, 'workspace');
  mkdirSync(workspace);
  const portProbe = createServer();
  await new Promise(done => portProbe.listen(0, '127.0.0.1', done));
  const restPort = portProbe.address().port;
  await new Promise(done => portProbe.close(done));
  const configPath = join(temp, 'config.json');
  const config = JSON.stringify({ agent: { agentBackend: 'codex', model: 'gpt-5.6-luna' },
    workspace: { dir: workspace },
    channels: { feishu: { enabled: false }, rest: { port: restPort, host: '127.0.0.1', fileStorageDir: join(workspace, 'files') } },
    logging: { level: 'silent' } });
  mkdirSync(join(workspace, 'research'));
  const preserved = new Map([[configPath, config], [join(workspace, 'user-data.txt'), 'preserved user data'],
    [join(workspace, '.runtime-env'), 'ACCEPTANCE_CREDENTIAL=synthetic-upgrade-fixture\n'],
    [join(workspace, 'research', 'state.json'), '{"documentId":"preserved-research-document","feedback":[{"id":"comment:reply","status":"accepted"}]}\n'],
    [join(workspace, 'research', 'user-note.md'), '用户原文与历史证据：保留 UTF-8 内容。\n']]);
  for (const [file, content] of preserved) writeFileSync(file, content, { mode: 0o600 });
  const env = { ...process.env, NODE_ENV: 'production', DISCLAUDE_CONFIG_PATH: configPath,
    LOCKFILE_PATH: join(temp, 'service.pid'), npm_config_cache: join(temp, 'cache'), npm_config_userconfig: join(temp, 'empty.npmrc') };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const verifyData = () => { for (const [file, content] of preserved) { assert.equal(readFileSync(file, 'utf8'), content, file); assert.equal(statSync(file).mode & 0o777, 0o600, file); } };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: temp, env, encoding: 'utf8', timeout: 240000 });
    if (result.signal || (result.error && ['ETIMEDOUT', 'ENOBUFS'].includes(result.error.code))) cleanupSafe = false;
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  console.log(`UPGRADE_RUNTIME ${process.version}; npm ${run('npm', ['--version']).trim()}`);
  let baselineProvenance;
  for (const [phase, ref] of [['baseline', baseline], ['upgrade', candidate], ['rollback', baseline]]) {
    run('npm', ['install', '-g', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', ref]);
    verifyData();
    const installed = join(prefix, 'lib/node_modules/disclaude');
    const provenance = JSON.parse(readFileSync(join(installed, 'release-source.json'), 'utf8'));
    if (phase === 'baseline') {
      if (baselineFingerprint) assert.equal(provenance.sourceFingerprint, baselineFingerprint);
      baselineProvenance = provenance;
    } else if (phase === 'upgrade') {
      assert.equal(provenance.sourceFingerprint, fingerprint);
    } else {
      assert.deepEqual(provenance, baselineProvenance, 'Rollback must restore the exact baseline provenance');
    }
    console.log(`UPGRADE_PROVENANCE ${phase} ${JSON.stringify(provenance)}`);
    const cli = join(prefix, 'bin/disclaude');
    assert.equal(run(cli, ['--version']).trim(), `disclaude v${provenance.version}`);
    const child = spawn(cli, ['start', '--config', configPath, '--api-port', '0'], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let childError;
    child.once('error', error => { childError = error; });
    const exited = new Promise(resolve => child.once('close', resolve));
    try {
      let url;
      for (let i = 0; i < 150; i++) {
        url = output.match(/HTTP API server started on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (url || childError || child.exitCode !== null || child.signalCode !== null) break;
        await delay(100);
      }
      assert(url, `CLI did not become healthy: ${childError || ''}\n${output}`);
      const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'ok');
      child.kill('SIGTERM');
      assert.equal(await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => 'timeout')]), 0, output);
      assert(!existsSync(env.LOCKFILE_PATH), 'Instance lock remains after stop');
      verifyData();
      console.log(`UPGRADE_PHASE_OK ${phase} ${provenance.version}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const closed = await Promise.race([exited.then(() => true), delay(15_000, undefined, { ref: false }).then(() => false)]);
      if (!closed || child.signalCode) {
        cleanupSafe = false;
        throw new Error(`Upgrade CLI termination unconfirmed; files retained at ${temp} (pid ${child.pid})`);
      }
    }
  }
  console.log('UPGRADE_ROLLBACK_OK config/runtime-env/user-data/research preserved with private file modes');
}
try {
  await verifyUpgrade();
} finally {
  if (!cleanupSafe || process.argv.includes('--keep-temp')) {
    console.error(`Upgrade test files retained at ${temp}; remove after diagnosis and after confirming all owned processes have stopped.`);
  } else {
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      assert(!existsSync(temp), `Upgrade test directory still exists: ${temp}`);
      console.log('UPGRADE_TEST_CLEANUP_OK');
    } catch (error) {
      throw new Error(`Upgrade test cleanup failed; inspect residual files at ${temp}`, { cause: error });
    }
  }
}
