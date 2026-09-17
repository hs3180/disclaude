/** Two real deployed tasks, controlled independently through public HTTP. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--help')) {
  console.log('JSON stdin: {baseUrl,apiToken,context,timeoutMs?}. Fresh real-message context required. Starts two fictional model tasks, pauses/corrects/resumes A while B completes, then archives both. JSON report only.');
  process.exit(0);
}
const report = { suite: 'deployed-task-isolation', startedAt: new Date().toISOString(), status: 'failed', steps: [], tasks: [], cleanup: [] };
let config, phase = 'input';
const created = [];
const pass = (name, detail = {}) => report.steps.push({ name, status: 'passed', ...detail });
try {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; assert(input.length <= 16_384); }
  config = JSON.parse(input);
  const url = new URL(config.baseUrl);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
  assert(typeof config.apiToken === 'string' && config.apiToken.length > 0);
  assert(typeof config.context === 'string' && /^[a-f0-9-]{36}$/u.test(config.context));
  config.baseUrl = url.origin;
  config.timeoutMs ??= 180_000;
  assert(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 600_000);
  pass('input');
  const nonce = randomUUID();
  phase = 'create-two-paused-tasks';
  for (const label of ['A', 'B']) {
    const requestId = `ISOLATION_${label}_${nonce}`;
    report.tasks.push({ label, requestId });
    const { task } = await call({ action: 'create', requestId, title: requestId,
      scope: label === 'A'
        ? 'Controlled lifecycle acceptance. First turn: run exactly sleep 30 once, then record the supplied baseline value as evidence, leave final reporting as pending work and return continue. Subsequent turns: do not sleep, preserve baseline evidence, apply any correction and complete with the current value. No other tools, files, network or messages.'
        : 'Controlled lifecycle acceptance. Run exactly sleep 30 once, then report the supplied value with source-backed evidence and complete. Use only this task material. Do not read/write files, browse, send messages or perform other side effects.',
      materials: label === 'A' ? 'Fictional task A only: value 17. This is not a real-world claim.' : 'Fictional task B only: value 73. This is not a real-world claim.' });
    created.push(task.id); Object.assign(report.tasks.at(-1), { id: task.id });
    assert.equal(task.status, 'paused'); assert(task.workingDir);
  }
  const [aId, bId] = created;
  pass(phase);
  phase = 'both-running';
  await Promise.all(created.map(async id => { const p = await get(id); await control(p, 'resume'); }));
  const [aStart, bStart] = await Promise.all(created.map(get));
  assert.equal(aStart.status, 'running'); assert.equal(bStart.status, 'running');
  pass(phase, { aRevision: aStart.revision, bRevision: bStart.revision });
  phase = 'pause-only-a';
  await control(await get(aId), 'pause');
  const paused = await wait(aId, ['paused']);
  const bDone = await wait(bId, ['completed']);
  const aUnchanged = await get(aId);
  assert.equal(aUnchanged.status, 'paused');
  assert.deepEqual(aUnchanged, paused);
  assert.equal(bDone.workingDir, bStart.workingDir);
  assert.match(bDone.summary, /(^|\D)73(?!\d)/u);
  assert(!bDone.feedback.length);
  assert(bDone.directions.some(d => d.findings.some(f => f.sources.some(s => /73/.test(s.excerpt)))));
  pass('b-completes-while-a-remains-paused', { aRevision: paused.revision, bRevision: bDone.revision });
  phase = 'a-feedback-does-not-start-execution';
  await control(aUnchanged, 'feedback', 'Correction for task A ONLY: its current fictional value is 19, replacing 17. Preserve baseline evidence and complete using 19 after explicit resume. Do not repeat the sleep.');
  const adjusted = await get(aId);
  assert.equal(adjusted.status, 'paused');
  assert.deepEqual(adjusted.directions, paused.directions);
  assert(adjusted.feedback.some(f => f.status === 'pending'));
  pass(phase);
  phase = 'a-resumes-with-isolated-correction';
  await control(adjusted, 'resume');
  const aDone = await wait(aId, ['completed']);
  assert.equal(aDone.workingDir, aStart.workingDir);
  assert.match(aDone.summary, /(^|\D)19(?!\d)/u);
  assert(aDone.feedback.every(f => f.status === 'applied'));
  for (const item of paused.directions.filter(d => d.status === 'done')) {
    assert.deepEqual(aDone.directions.find(d => d.id === item.id), item);
  }
  assert.deepEqual(await get(bId), bDone);
  pass(phase, { aRevision: aDone.revision, bRevision: bDone.revision, retainedCompletedWork: paused.directions.filter(d => d.status === 'done').length });
  report.status = 'passed';
} catch {
  report.failedStep = phase;
  report.error = 'Acceptance did not finish; inspect the named step and deployment logs.';
} finally {
  for (const descriptor of report.tasks) {
    if (!descriptor.id) { report.cleanup.push({ requestId: descriptor.requestId, status: 'needs-inspection', reason: 'Creation outcome unknown' }); report.status = 'failed'; continue; }
    try {
      let p = await get(descriptor.id);
      if (!['completed', 'cancelled'].includes(p.status)) { await control(p, 'cancel'); p = await wait(p.id, ['completed', 'cancelled'], 60_000); }
      await control(p, 'archive');
      assert((await get(p.id)).archivedAt);
      report.cleanup.push({ taskId: p.id, status: 'archived', retained: 'acceptance evidence' });
    } catch { report.cleanup.push({ taskId: descriptor.id, status: 'needs-inspection' }); report.status = 'failed'; }
  }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
async function call(operation) {
  const response = await fetch(config.baseUrl + '/api/project-tasks', { method: 'POST',
    headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ context: config.context, operation }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.ok, true); return value.result;
}
async function get(taskId) { return (await call({ action: 'get', taskId })).task; }
async function control(p, control, value) { return call({ action: 'control', taskId: p.id, revision: p.revision, control, ...(value ? { value } : {}) }); }
async function wait(id, states, timeout = config.timeoutMs) {
  const deadline = Date.now() + timeout;
  do {
    const p = await get(id);
    if (states.includes(p.status)) { return p; }
    assert(!['failed', 'waiting-user', 'cancelled', 'completed'].includes(p.status));
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error('Task wait expired');
}
