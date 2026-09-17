#!/usr/bin/env node
// External acceptance client. No imports from Disclaude's implementation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'service-url': { type: 'string' }, workspace: { type: 'string' }, socket: { type: 'string' },
} });
for (const key of ['service-url', 'workspace', 'socket']) {
  assert(values[key], `Required: --${key}`);
}
const base = new URL(values['service-url']);
assert(['http:', 'https:'].includes(base.protocol), 'Expected an HTTP service URL');
const root = resolve(values.workspace);
const id = randomUUID();
const chatId = `rest-browser-acceptance-${id}`;
const marker = `ordinary-agent-${id}`;
const probeFile = join(root, `agent-browser-env-${id}.cjs`);
const reportFile = join(root, `agent-browser-env-${id}.json`);
const started = Date.now();
const checks = [];
let submitted = false;
let completed = false;
let failed = false;

async function request(path, body, timeout = 120_000) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  assert(response.ok, `HTTP ${response.status} from ${path}`);
  const result = await response.json();
  assert.equal(result.success, true, `${path} did not succeed`);
  return result;
}

async function readBrowser() {
  // The reader is independent of the agent and uses the service-owned CLI.
  const env = { ...process.env };
  delete env.BU_CDP_URL;
  delete env.BU_CDP_WS;
  delete env.CHROMIUM_CDP_PORT;
  env.DISCLAUDE_BROWSER_SOCKET = values.socket;
  env.DISCLAUDE_BROWSER_BIN = join(root, 'bin');
  const child = spawn(join(root, 'bin', 'browser-use'), [], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
  try {
    const result = new Promise((done, reject) => {
      child.once('error', reject);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('close', code => code === 0 && !timedOut ? done(stdout)
        : reject(new Error(`Independent browser readback failed (${code}, timeout=${timedOut}): ${stderr}`)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end('print(js("document.querySelector(\'#value\').value"))\n');
    return await result;
  } finally { clearTimeout(timer); }
}

try {
  const keys = ['BU_CDP_URL', 'BU_CDP_WS', 'CHROMIUM_CDP_PORT', 'DISCLAUDE_BROWSER_SOCKET', 'DISCLAUDE_BROWSER_BIN'];
  const collect = `JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null])))`;
  await writeFile(probeFile, `const fs=require('node:fs'),cp=require('node:child_process'); const main=${collect}; const child=cp.execFileSync(process.execPath,['-e',${JSON.stringify(`process.stdout.write(${collect})`)}],{encoding:'utf8'}); fs.writeFileSync(${JSON.stringify(reportFile)},JSON.stringify({main:JSON.parse(main),child:JSON.parse(child)}));`, { mode: 0o600 });
  const script = `fill_input('#value', ${JSON.stringify(marker)})\nprint(js("document.querySelector('#value').value"))\n`;
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(probeFile)} && printf '%s' ${quote(script)} | browser-use`;
  submitted = true;
  const result = await request('/api/chat/sync', {
    chatId, userId: 'browser-acceptance-user',
    message: `Use your shell tool to run exactly this command:\n${command}\nThen reply with ${marker}. This is an isolated browser acceptance task. Do not delegate, use direct CDP, launch a browser, inspect credentials, contact other services or modify unrelated files.`,
  });
  completed = true;
  assert.equal(result.chatId, chatId);
  assert(result.response?.includes(marker), 'Actual REST response must contain the marker');
  checks.push('deployment REST response');
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  for (const observed of [report.main, report.child]) {
    assert.deepEqual(observed, { BU_CDP_URL: null, BU_CDP_WS: null, CHROMIUM_CDP_PORT: null,
      DISCLAUDE_BROWSER_SOCKET: values.socket, DISCLAUDE_BROWSER_BIN: join(root, 'bin'),
    });
  }
  checks.push('tool and ordinary child browser environment');
  assert((await readBrowser()).includes(marker), 'Independent browser readback must contain the marker');
  checks.push('independent browser readback');
} catch (error) {
  failed = true;
  process.exitCode = 1;
  console.error(`FAIL browser chat entry: ${error.message}`);
} finally {
  if (submitted && !completed) {
    try { await request('/api/control', { type: 'stop', chatId }, 10_000); }
    catch { console.error('STOP_UNCONFIRMED: deployment owner must stop the isolated service before workspace cleanup'); }
  }
  // On unfinished requests the service may still use the probe; its owner joins
  // service shutdown before deleting the run workspace, including these files.
  if (!submitted || completed) {
    await Promise.all([probeFile, reportFile].map(file => rm(file, { force: true })));
  }
  console.info('BROWSER_CHAT_AGENT_ENTRY', JSON.stringify({
    status: failed ? 'failed' : 'passed', entry: 'external-process-rest', chatId,
    configuredBackend: process.env.DISCLAUDE_E2E_BROWSER_CHAT_AGENT_BACKEND ?? 'deepseek',
    checks, durationMs: Date.now() - started, completed,
    fixtureCleanup: !submitted || completed ? 'removed' : 'deferred-to-deployment-owner',
    ...(!submitted || completed ? {} : { retainedFixtures: [probeFile, reportFile] }),
  }));
}
