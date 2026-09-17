/** External acceptance client. Reads deployment credentials/context on stdin;
 * never imports service internals, starts a fake controller or mints authority. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--help')) {
  console.log('Pass JSON on stdin: {baseUrl, apiToken, context, timeoutMs?}. Use a fresh task context issued by a real message in the dedicated acceptance chat. Output is a sanitized JSON report. Requires a deployed candidate and configured model; creates one task and archives it on cleanup.');
  process.exit(0);
}
const report = { suite: 'deployed-project-task', startedAt: new Date().toISOString(), status: 'failed', steps: [], cleanup: { status: 'not-needed' } };
let config, task;
let phase = 'input';
const record = (name, details = {}) => report.steps.push({ name, status: 'passed', ...details });
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16_384) { throw new Error('Input too large'); }
  }
  config = JSON.parse(input);
  const url = new URL(config.baseUrl);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
  assert(typeof config.apiToken === 'string' && config.apiToken.length > 0);
  assert(typeof config.context === 'string' && /^[a-f0-9-]{36}$/u.test(config.context));
  config.timeoutMs ??= 180_000;
  assert(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 600_000);
  config.baseUrl = url.origin;
  record('input');
  phase = 'reject-unauthenticated';
  await request({ action: 'list', limit: 1 }, { token: 'invalid-' + randomUUID(), expected: 401 });
  record('reject-unauthenticated');
  phase = 'reject-unissued-context';
  await request({ action: 'list' }, { context: randomUUID(), expected: 403 });
  record('reject-unissued-context');
  phase = 'reject-client-selected-actor';
  await request({ action: 'list', owner: 'forged-actor' }, { expected: 400 });
  record('reject-client-selected-actor');
  phase = 'live-message-context';
  await request({ action: 'list', limit: 1 });
  record('live-message-context');
  const marker = 'ACCEPTANCE_' + randomUUID();
  const create = { action: 'create', requestId: marker, title: marker,
    scope: 'Use only supplied fictional material. Compare the two values, record source-backed evidence and report their difference numerically. Complete this bounded task without tools, file changes, messages, schedules or other side effects.',
    materials: `Fictional acceptance material ${marker}: A costs 23 points, B costs 31 points. These are test values, not real prices.` };
  phase = 'create-paused-with-fixed-directory';
  report.requestId = marker;
  report.cleanup = { status: 'needs-inspection', reason: 'Creation attempted; task identity not yet confirmed' };
  ({ task } = await request(create));
  assert.equal(task.status, 'paused');
  assert.equal(typeof task.workingDir, 'string');
  assert(task.workingDir.length > 0);
  report.taskId = task.id;
  record('create-paused-with-fixed-directory');
  phase = 'idempotent-create';
  const duplicate = await request(create);
  assert.equal(duplicate.task.id, task.id);
  record('idempotent-create');
  phase = 'reject-stale-control';
  await request({ action: 'control', taskId: task.id, revision: task.revision + 100, control: 'resume' }, { expected: 409 });
  record('reject-stale-control');
  phase = 'model-completion-with-evidence';
  const originalDirectory = task.workingDir;
  await request({ action: 'control', taskId: task.id, revision: task.revision, control: 'resume' });
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    ({ task } = await request({ action: 'get', taskId: task.id }));
    if (['completed', 'failed', 'waiting-user', 'cancelled'].includes(task.status)) { break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(task.status, 'completed');
  assert.equal(task.workingDir, originalDirectory);
  assert.match(task.summary, /(^|\D)8(?!\d)/u);
  const evidence = task.directions.flatMap(item => item.findings);
  const quoted = evidence.flatMap(item => item.sources.map(source => source.excerpt)).join('\n');
  assert.match(quoted, /(^|\D)23(?!\d)/u);
  assert.match(quoted, /(^|\D)31(?!\d)/u);
  assert(task.directions.every(item => item.status !== 'pending'));
  record('model-completion-with-evidence', { revision: task.revision, evidenceCount: evidence.length });
  report.status = 'passed';
} catch {
  // Raw errors/responses can contain credentials, user material or model text.
  report.failedStep = phase;
  report.error = 'Acceptance did not finish; inspect the named step and deployment logs.';
} finally {
  if (task?.id) {
    report.cleanup = { status: 'pending', taskId: task.id, retained: 'task record retained as acceptance evidence' };
    try {
      ({ task } = await request({ action: 'get', taskId: task.id }));
      if (!['completed', 'cancelled'].includes(task.status)) {
        await request({ action: 'control', taskId: task.id, revision: task.revision, control: 'cancel' });
        const deadline = Date.now() + 60_000;
        do {
          ({ task } = await request({ action: 'get', taskId: task.id }));
          if (['completed', 'cancelled'].includes(task.status)) { break; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        } while (Date.now() < deadline);
      }
      assert(['completed', 'cancelled'].includes(task.status));
      await request({ action: 'control', taskId: task.id, revision: task.revision, control: 'archive' });
      ({ task } = await request({ action: 'get', taskId: task.id }));
      assert(task.archivedAt);
      report.cleanup.status = 'archived';
    } catch {
      report.cleanup.status = 'needs-inspection';
      report.status = 'failed';
    }
  }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
async function request(operation, { expected = 200, token = config.apiToken, context = config.context } = {}) {
  const response = await fetch(config.baseUrl + '/api/project-tasks', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ context, operation }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, expected);
  const value = await response.json();
  if (expected === 200) { assert.equal(value.ok, true); return value.result; }
  if (expected === 401) { assert.equal(value.error, 'Unauthorized'); }
  else { assert.equal(value.ok, false); }
}
