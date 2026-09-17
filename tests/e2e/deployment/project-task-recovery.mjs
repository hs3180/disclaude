/** External, two-phase recovery acceptance. The operator owns deployment restart. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--help')) {
  console.log('JSON stdin: {baseUrl,apiToken,context,phase:"prepare"|"resume",checkpoint?,timeoutMs?,documentUrl?,commentMarker?}. Prepare leaves one task running and emits a checkpoint. Optional document fixture uses A41/B48; operator changes body A58 and comments B rebate14 before resume, passing commentMarker. Resume uses a fresh real-message context and archives the task. This client never kills/starts services or edits documents.');
  process.exit(0);
}
const report = { suite: 'deployed-task-recovery', startedAt: new Date().toISOString(), status: 'failed', steps: [], cleanup: [] };
let config, taskId, requestId, phase = 'input', prepared = false;
const pass = name => report.steps.push({ name, status: 'passed' });
try {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; assert(input.length <= 262_144); }
  config = JSON.parse(input);
  const url = new URL(config.baseUrl);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
  assert(typeof config.apiToken === 'string' && config.apiToken.length > 0);
  assert(typeof config.context === 'string' && /^[a-f0-9-]{36}$/u.test(config.context));
  assert(['prepare', 'resume'].includes(config.phase));
  if (config.documentUrl !== undefined) { assert(typeof config.documentUrl === 'string' && /^https:\/\/[^/]+\/docx\/[a-zA-Z0-9]+$/u.test(config.documentUrl)); }
  config.baseUrl = url.origin;
  config.timeoutMs ??= 180_000;
  assert(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 600_000);
  pass(phase);
  if (config.phase === 'prepare') {
    phase = 'create-recovery-task';
    requestId = `RECOVERY_${randomUUID()}`;
    report.requestId = requestId;
    const { task } = await call({ action: 'create', requestId, title: requestId,
      scope: 'Controlled recovery acceptance. First turn: use no tools; '
        + (config.documentUrl ? 'read the supplied linked-document snapshot and record BOTH original proposal prices as completed source-backed work, ' : 'record supplied fictional baseline 41 as completed source-backed work, ')
        + 'create a separate pending final-report item, and return continue. Second turn: use the shell execution tool to start exactly /bin/sleep 120 as a real operating-system child process once before doing any further work. Do not substitute a clock/sleep tool, JavaScript timer or simulated wait: the operator must observe the OS sleep process and interrupt its service owner. If shell execution is unavailable, return waiting-user and explain that limitation. After restart, when correction feedback is present, do not sleep or use tools: preserve previously completed baseline work, apply the correction and complete the pending final report. '
        + (config.documentUrl ? 'Use the latest linked-document body and comments, report both current proposal totals and their numerical difference. Do not refetch the document yourself; the harness supplies its snapshot. ' : '')
        + 'No files, network, messages, schedules or other side effects.',
      materials: config.documentUrl ? 'Use the linked document as the source of the fictional proposal prices and subsequent corrections. These are not real-world quotes.' : 'Fictional recovery fixture: baseline value 41. This is not a real-world claim.',
      ...(config.documentUrl ? { documentUrl: config.documentUrl } : {}) });
    taskId = task.id; report.taskId = taskId;
    assert.equal(task.status, 'paused'); assert(task.workingDir);
    await control(task, 'resume');
    phase = 'committed-checkpoint-before-interruption';
    const checkpoint = await wait(p => p.status === 'running' && p.stepCount >= 1
      && p.directions.some(d => d.status === 'done' && d.findings.some(f => f.sources.some(s => /41/.test(s.excerpt))))
      && p.directions.some(d => d.status === 'pending'));
    report.checkpoint = { id: checkpoint.id, title: checkpoint.title, workingDir: checkpoint.workingDir,
      directions: checkpoint.directions, stepCount: checkpoint.stepCount, revision: checkpoint.revision };
    if (config.documentUrl) {
      assert(checkpoint.document?.snapshot?.rawBody.includes('Proposal A costs USD 41.'));
      assert(checkpoint.document.snapshot.rawBody.includes('Proposal B costs USD 48.'));
      assert(checkpoint.directions.some(d => d.status === 'done' && d.findings.some(f => f.sources.some(s => /48/.test(s.excerpt)))));
      report.checkpoint.document = checkpoint.document.snapshot;
    }
    pass(phase);
    prepared = true;
    report.status = 'prepared';
    report.next = 'Operator must verify an active next-turn tool, crash/restart the owned test deployment, and obtain a fresh context before running resume. Preparation alone is not recovery acceptance.';
  } else {
    phase = 'validate-owned-checkpoint';
    const prior = config.checkpoint;
    assert(prior && typeof prior.id === 'string' && /^[a-f0-9-]{36}$/u.test(prior.id));
    assert(typeof prior.title === 'string' && /^RECOVERY_[a-f0-9-]{36}$/u.test(prior.title));
    assert(typeof prior.workingDir === 'string' && Array.isArray(prior.directions));
    assert(prior.directions.some(d => d.status === 'done' && d.findings.length));
    if (prior.document) { assert(typeof config.commentMarker === 'string' && /^[a-zA-Z0-9_-]{8,100}$/u.test(config.commentMarker)); }
    // Do not acquire cleanup ownership until the context-authorized read matches the fixture.
    const reopened = (await call({ action: 'get', taskId: prior.id })).task;
    assert.equal(reopened.title, prior.title);
    assert.equal(reopened.workingDir, prior.workingDir);
    taskId = prior.id; report.taskId = taskId;
    phase = 'interrupted-checkpoint-retained';
    assert.equal(reopened.status, 'interrupted');
    assert.deepEqual(reopened.directions, prior.directions);
    assert.equal(reopened.stepCount, prior.stepCount);
    pass(phase);
    if (prior.document) {
      phase = 'document-checkpoint-before-resume';
      assert.equal(reopened.document?.token, prior.document.token);
      assert.equal(reopened.document.snapshot.rawBody, prior.document.rawBody);
      assert(!reopened.feedback.some(f => f.text.includes(config.commentMarker)));
      pass(phase);
      // No direct feedback injection: the harness must discover real document edits.
      await control(reopened, 'resume');
    } else {
      phase = 'feedback-before-explicit-resume';
      await control(reopened, 'feedback', 'Recovery correction: the current fictional value is 58 instead of baseline 41. Keep the already completed baseline evidence unchanged. The previous wait was interrupted: do not wait again or use any tools. Complete the pending report using 58 after explicit resume.');
      const adjusted = await get();
      assert.equal(adjusted.status, 'interrupted');
      assert.deepEqual(adjusted.directions, prior.directions);
      assert(adjusted.feedback.some(f => f.status === 'pending'));
      pass(phase);
      await control(adjusted, 'resume');
    }
    phase = 'recovered-completion';
    const done = await wait(p => p.status === 'completed');
    assert.equal(done.workingDir, prior.workingDir);
    assert.match(done.summary, /(^|\D)58(?!\d)/u);
    assert(done.feedback.every(f => f.status === 'applied'));
    for (const item of prior.directions.filter(d => d.status === 'done')) {
      assert.deepEqual(done.directions.find(d => d.id === item.id), item);
    }
    assert(done.directions.some(d => d.findings.some(f => f.sources.some(s => /58/.test(s.excerpt)))));
    if (prior.document) {
      assert.match(done.summary, /(^|\D)34(?!\d)/u); assert.match(done.summary, /(^|\D)24(?!\d)/u);
      assert(done.document.snapshot.rawBody.includes('Proposal A costs USD 58.'));
      assert(done.document.snapshot.comments.some(c => c.text.includes(config.commentMarker)));
      assert(done.document.previous.some(s => s.rawBody === prior.document.rawBody));
      const comment = done.feedback.find(f => f.text.includes(config.commentMarker) && f.sourceKey?.includes(':comment:'));
      assert(comment?.status === 'applied' && comment.directionIds.length);
      assert(done.feedback.some(f => f.status === 'applied' && f.sourceKey?.includes(':body') && f.text.includes('58')));
      pass('latest-document-body-and-comment-applied');
    }
    pass(phase);
    report.status = 'passed';
  }
} catch {
  report.failedStep = phase;
  report.error = 'Acceptance did not finish; inspect the named step and deployment logs.';
} finally {
  if (prepared) {
    report.cleanup.push({ taskId, status: 'retained-for-recovery', reason: 'Intentional running fixture; operator must resume or cancel/archive it.' });
  } else if (taskId) {
    try {
      let p = await get();
      if (!['completed', 'cancelled'].includes(p.status)) { await control(p, 'cancel'); p = await wait(p => ['completed', 'cancelled'].includes(p.status), 180_000); }
      await control(p, 'archive'); assert((await get()).archivedAt);
      report.cleanup.push({ taskId, status: 'archived', retained: 'acceptance evidence' });
    } catch { report.cleanup.push({ taskId, status: 'needs-inspection' }); report.status = 'failed'; }
  } else if (requestId) {
    report.cleanup.push({ requestId, status: 'needs-inspection', reason: 'Creation outcome unknown' });
  }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = ['prepared', 'passed'].includes(report.status) ? 0 : 1;
}
async function call(operation) {
  const response = await fetch(config.baseUrl + '/api/project-tasks', { method: 'POST',
    headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ context: config.context, operation }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.ok, true); return value.result;
}
async function get() { return (await call({ action: 'get', taskId })).task; }
async function control(p, control, value) { return call({ action: 'control', taskId: p.id, revision: p.revision, control, ...(value ? { value } : {}) }); }
async function wait(predicate, timeout = config.timeoutMs) {
  const deadline = Date.now() + timeout;
  do {
    const p = await get();
    if (predicate(p)) { return p; }
    assert(!['failed', 'waiting-user', 'cancelled', 'completed'].includes(p.status));
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error('Task wait expired');
}
