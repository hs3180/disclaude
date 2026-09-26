#!/usr/bin/env node
// External client: actual deployment REST requests, no application imports.
import assert from 'node:assert/strict';
import { access, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({ options: Object.fromEntries(
  ['service-url', 'workspace', 'socket'].map(key => [key, { type: 'string' }]),
) });
for (const key of ['service-url', 'workspace', 'socket']) { assert(values[key], `Required: --${key}`); }
const base = new URL(values['service-url']);
assert(['http:', 'https:'].includes(base.protocol), 'Expected an HTTP service URL');
const root = resolve(values.workspace), id = randomUUID();
const held = join(root, `agent-a-held-${id}`), release = join(root, `agent-a-release-${id}`);
const secondRan = join(root, `agent-b-ran-${id}`);
const firstValue = `draft-a-${id}`, finalValue = `reviewed-b-${id}`;
const chats = [], requests = [], checks = [];
const settledChats = new Map();
const started = Date.now();
let failed = false, completed = false, queueWaitMs;
const execAsync = promisify(execFile);
const exists = file => access(file).then(() => true, error => {
  if (error.code === 'ENOENT') { return false; }
  throw error;
});
async function browserStatus() {
  const statusEnv = { ...process.env, DISCLAUDE_BROWSER_SOCKET: values.socket };
  const { stdout } = await execAsync(process.execPath, [resolve('bin/disclaude.js'), 'browser', 'status'],
    { env: statusEnv, cwd: root, timeout: 5000 });
  return JSON.parse(stdout);
}
async function waitFor(check, description) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    if (settledChats.size) {
      const [chatId, outcome] = settledChats.entries().next().value;
      throw new Error(`${description}: ${chatId} ended before the expected browser action (${outcome})`);
    }
    await delay(100);
  }
  throw new Error(`Contention deadline: ${description}`);
}
async function post(path, body, timeout = 200_000) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  assert(response.ok, `HTTP ${response.status} from ${path}`);
  const result = await response.json();
  assert.equal(result.success, true, `${path} did not succeed`);
  return result;
}
function start(script, label) {
  const chatId = `rest-contention-${id}-${label}`;
  chats.push(chatId);
  const quoted = `'${script.replaceAll("'", "'\\''")}'`;
  const promise = post('/api/chat/sync', { chatId, userId: 'browser-acceptance-user',
    message: `Run exactly this shell command with your shell tool, then report its output verbatim:\nprintf '%s' ${quoted} | browser-use\nThis is a shared local draft acceptance fixture. Do not change the script, run extra tools, launch another browser, use direct CDP, delegate, or touch unrelated files.`,
  }).then(result => { assert.equal(result.chatId, chatId); return result.response; });
  // Observe both rejections even while checking the other chat's browser lease.
  void promise.then(response => {
    // Include only a diagnostic category and length, never raw model text.
    const category = /auth|api.key|unauthoriz|401|403/i.test(response ?? '') ? 'authentication response' : 'unexpected early response';
    settledChats.set(chatId, `${category}, ${response?.length ?? 0} characters`);
  }, error => { settledChats.set(chatId, error.name); });
  requests.push(promise);
  return promise;
}
async function readBrowser() {
  const env = { ...process.env, DISCLAUDE_BROWSER_SOCKET: values.socket };
  delete env.BU_CDP_URL; delete env.BU_CDP_WS; delete env.CHROMIUM_CDP_PORT;
  const child = spawn(join(root, 'bin', 'browser-use'), [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
  try {
    const result = new Promise((done, reject) => {
      child.once('error', reject);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('close', code => code === 0 && !timedOut ? done(stdout)
        : reject(new Error(`Readback failed (${code}, timeout=${timedOut}): ${stderr}`)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end('print(js("document.querySelector(\'#value\').value"))\n');
    return await result;
  } finally { clearTimeout(timer); }
}
try {
  const first = start(`import os, time\nfill_input('#value', ${JSON.stringify(firstValue)})\nopen(${JSON.stringify(held)}, 'w').write('held')\nend = time.monotonic() + 100\nwhile not os.path.exists(${JSON.stringify(release)}):\n    assert time.monotonic() < end, 'release deadline exceeded'\n    time.sleep(0.1)\nprint('AGENT_A:' + js("document.querySelector('#value').value"))\n`, 'a');
  await waitFor(() => exists(held), 'agent A holds the browser');
  const queueStarted = Date.now();
  const second = start(`previous = js("document.querySelector('#value').value")\nassert previous == ${JSON.stringify(firstValue)}\nopen(${JSON.stringify(secondRan)}, 'w').write('executed')\nfill_input('#value', ${JSON.stringify(finalValue)})\nprint('AGENT_B_PREVIOUS:' + previous)\n`, 'b');
  await waitFor(async () => {
    return (await browserStatus()).queued >= 1;
  }, 'agent B enters the coordinator queue');
  assert.equal(await exists(secondRan), false, 'Agent B must not execute while A holds the browser');
  queueWaitMs = Date.now() - queueStarted;
  checks.push('B queued while A holds lease; no early execution');
  await writeFile(release, 'release');
  const results = await Promise.all([first, second]);
  completed = true;
  assert(results[0]?.includes(`AGENT_A:${firstValue}`), 'Actual A response contains its observed draft');
  assert(results[1]?.includes(`AGENT_B_PREVIOUS:${firstValue}`), 'Actual B response contains A draft');
  assert.equal(await exists(secondRan), true);
  checks.push('two independent deployment REST responses; B observed A draft');
  assert.equal((await browserStatus()).queued, 0, 'Coordinator queue should drain after both callers finish');
  checks.push('queue drains after sequential handoff');
  assert((await readBrowser()).includes(finalValue), 'Independent final draft readback');
  checks.push('independent final draft readback');
} catch (error) {
  failed = true; process.exitCode = 1;
  console.error(`FAIL browser contention: ${error.message}`);
} finally {
  // Release the browser even when an observation fails. The deployment owner
  // remains responsible for stopping/joining its service before root cleanup.
  await writeFile(release, 'release');
  if (!completed) {
    await Promise.all(chats.map(async chatId => {
      try { await post('/api/control', { type: 'stop', chatId }, 10_000); }
      catch { console.error(`STOP_UNCONFIRMED ${chatId}`); }
    }));
    await Promise.race([Promise.allSettled(requests), delay(10_000, undefined, { ref: false })]);
  } else {
    await Promise.all([held, release, secondRan].map(file => rm(file, { force: true })));
  }
  console.info('BROWSER_MODEL_CONTENTION', JSON.stringify({ status: failed ? 'failed' : 'passed',
    entry: 'external-process-rest', chats, checks, queueWaitMs, durationMs: Date.now() - started,
    fixtureCleanup: completed ? 'removed' : 'deferred-to-deployment-owner',
    ...(!completed ? { retainedFixtures: [held, release, secondRan] } : {}),
  }));
}
