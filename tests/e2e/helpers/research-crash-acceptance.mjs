import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  captureDescendantGroups,
  signalDescendantGroups,
} from '../../../packages/core/dist/sdk/providers/codex/owned-descendants.js';
const root = await mkdtemp(join(tmpdir(), 'research-real-crash-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { root };
const children = [];
let groups = [];
let resumedGroups = [];
let safe = false;
const rows = async () => {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], {
    timeout: 2000,
  });
  return stdout.split('\n').flatMap((s) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(s);
    return m ? [{ pid: +m[1], parent: +m[2], group: +m[3], name: m[4].split('/').pop() }] : [];
  });
};
function start(phase) {
  const child = spawn(
    process.execPath,
    [resolve('tests/e2e/helpers/research-crash-worker.mjs'), root, phase],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  const messages = [];
  child.on('message', (m) => messages.push(m));
  const exited = new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const item = { child, messages, exited, output: () => output };
  children.push(item);
  return item;
}
async function waitUntil(f, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await pause(200);
  }
  throw new Error('Acceptance observation deadline exceeded');
}
try {
  const before = 'before-' + randomUUID(),
    after = 'after-' + randomUUID();
  await writeFile(join(root, 'inventory.txt'), before + ' count 5\n');
  const first = start('first');
  await waitUntil(async () => {
    const captured = await captureDescendantGroups(first.child.pid);
    groups = captured;
    return (await rows()).some(
      (p) => groups.some((g) => g.group === p.group) && p.name === 'sleep'
    );
  }, 90000);
  const initial = first.messages.find((m) => m.kind === 'research').research;
  evidence.researchId = initial.id;
  evidence.capturedGroupCount = groups.length;
  evidence.activeBeforeCrash = (await rows()).filter((p) =>
    groups.some((g) => g.group === p.group)
  );
  first.child.kill('SIGKILL');
  assert.deepEqual(await first.exited, { code: null, signal: 'SIGKILL' });
  await pause(2500);
  evidence.remainingAfterCrash = (await rows()).filter((p) =>
    groups.some((g) => g.group === p.group)
  );
  console.log('CRASH_OBSERVATION', JSON.stringify(evidence));
  // Explicit test-owned remediation; never count it as product crash cleanup.
  if (evidence.remainingAfterCrash.length) {
    await signalDescendantGroups(groups, 'SIGTERM');
    await pause(1200);
    await signalDescendantGroups(groups, 'SIGKILL');
  }
  await waitUntil(
    async () => !(await rows()).some((p) => groups.some((g) => g.group === p.group)),
    10000
  );
  evidence.manualRemediation = evidence.remainingAfterCrash.length > 0;
  const changed = after + ' count 9\n';
  await writeFile(join(root, 'inventory.txt'), changed);
  const second = start('resume');
  await waitUntil(async () => {
    if (second.child.exitCode !== null || second.child.signalCode !== null) return true;
    for (const group of await captureDescendantGroups(second.child.pid))
      if (!resumedGroups.some((g) => g.pid === group.pid && g.started === group.started))
        resumedGroups.push(group);
    return false;
  }, 120000);
  const exit = await second.exited;
  assert.equal(exit.code, 0, second.output().slice(-3000));
  const reopened = second.messages.find((m) => m.kind === 'reopened').research,
    finished = second.messages.find((m) => m.kind === 'finished').research;
  assert.equal(reopened.id, initial.id);
  assert.equal(reopened.status, 'interrupted');
  assert.equal(finished.status, 'completed', finished.error);
  assert.ok(finished.summary.includes(after));
  assert.ok(finished.summary.includes('9'));
  assert.ok(!finished.summary.includes(before));
  assert.equal(finished.feedback[0].status, 'applied');
  assert.equal(await readFile(join(root, 'inventory.txt'), 'utf8'), changed);
  evidence.resumed = {
    id: finished.id,
    status: finished.status,
    summary: finished.summary,
    feedback: finished.feedback[0].status,
  };
  await waitUntil(
    async () => !(await rows()).some((p) => resumedGroups.some((g) => g.group === p.group)),
    10000
  );
  safe = true;
  assert.equal(
    evidence.manualRemediation,
    false,
    'Product crash cleanup required manual remediation'
  );
  console.log('REAL_CRASH_RESUME_RESULT', JSON.stringify(evidence));
} finally {
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      groups.push(...(await captureDescendantGroups(child.pid)));
      await signalDescendantGroups(groups, 'SIGTERM');
      child.kill('SIGKILL');
    }
    await exited;
  }
  await signalDescendantGroups([...groups, ...resumedGroups], 'SIGKILL');
  if (safe) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log('ROOT_RECLAIMED', root);
  } else console.log('ROOT_RETAINED', root);
}
