import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';
import { createCLIProbe, probeSource } from './cli-probe-client.mjs';

const { values } = parseArgs({
  options: { 'env-file': { type: 'string' }, output: { type: 'string' } },
});
if (!values['env-file'] || !values.output)
  throw new Error('Explicit environment file and fresh output required');
const directory = path.resolve(values.output);
fs.mkdirSync(directory, { mode: 0o700 });
const project = path.join(directory, 'project');
fs.mkdirSync(project, { mode: 0o700 });
const env = parseEnv(fs.readFileSync(values['env-file'], 'utf8'));
if (!env.JUPYTERLAB_HOST || !env.JUPYTERLAB_PASS)
  throw new Error('Configured credentials unavailable');
const client = new DatalayerJupyterClient({
  baseUrl: env.JUPYTERLAB_HOST,
  password: async () => env.JUPYTERLAB_PASS,
  allowInsecureHttp: true,
});
const before = {
  kernels: await client.json('api/kernels'),
  sessions: await client.json('api/sessions'),
};
const probe = await createCLIProbe({
  envFile: values['env-file'],
  project,
  directory: project,
  observe: true,
});
const file = `disclaude-datalayer-fault-${randomUUID().slice(0, 8)}.ipynb`;
const report = {
  source: probeSource(),
  startedAt: new Date().toISOString(),
  scope:
    'Public CLI with an observer forwarding to the configured remote Jupyter; injected HTTP failures and an owned kernel restart, no Jupyter service restart',
  checks: [],
  ownedNotebooks: [],
  requests: probe.requests,
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const persist = () => {
  const text = JSON.stringify(report, null, 2);
  if (text.includes(env.JUPYTERLAB_PASS)) throw new Error('Credential reached evidence');
  fs.writeFileSync(path.join(directory, 'report.json'), text + '\n', { mode: 0o600 });
};
const check = (name, passed, evidence) => {
  report.checks.push({ name, passed, evidence });
  persist();
  console.log(JSON.stringify({ name, passed }));
};
const posts = () =>
  probe.requests.filter((r) => r.method === 'POST' && r.route.endsWith('/execute')).length;
let notebookId, kernelId;
const call = probe.call;
const args = async (runId) => ({
  notebookId,
  cellId: 'fault-code',
  runId,
  expectedSourceHash: (await call('notebook_read_cell', { notebookId, cellId: 'fault-code' }))
    .sourceHash,
});
async function edit(source) {
  const cell = await call('notebook_read_cell', { notebookId, cellId: 'fault-code' });
  const result = await call('notebook_edit_cell', {
    notebookId,
    cellId: 'fault-code',
    expectedSourceHash: cell.sourceHash,
    source,
  });
  if (result.state !== 'edited') throw new Error('Owned source was not edited');
}
async function terminal(handle) {
  const deadline = Date.now() + 20000;
  do {
    const result = await client.observe(handle);
    if (!['accepted', 'running'].includes(result.state)) return result;
    await wait(150);
  } while (Date.now() < deadline);
  throw new Error('Original native request did not finish');
}
try {
  const linked = await probe.command('create', undefined, ['--path', file]);
  report.ownedNotebooks.push(file);
  notebookId = linked.notebookId;
  await call('notebook_insert_cell', {
    notebookId,
    cellId: 'fault-note',
    beforeCellId: '',
    cellType: 'markdown',
    source: 'Preserve this independent note across failures.',
  });
  await call('notebook_insert_cell', {
    notebookId,
    cellId: 'fault-code',
    beforeCellId: '',
    cellType: 'code',
    source:
      "import time\nfault_memory=11\nprint('AUTH_ORIGINAL_BEGIN',flush=True)\ntime.sleep(15)\nprint('AUTH_ORIGINAL_RESULT',fault_memory)",
  });
  const originalArgs = await args('auth-original');
  const accepted = await call('notebook_execute', originalArgs);
  if (accepted.state !== 'accepted') throw new Error('Original request was not accepted');
  const initial = await call('notebook_status', { notebookId, runId: originalArgs.runId });
  kernelId = initial.kernelId;
  const handle = { kernelId, requestId: accepted.requestId };
  // kernel_info_request can wait behind busy Python code. The accepted journal
  // already contains the incarnation verified before execution was submitted.
  const incarnation = { kernelId, incarnation: initial.kernelIncarnation };
  if (!incarnation.incarnation) throw new Error('Accepted run omitted kernel incarnation');
  const requestRoute = (r) =>
    r.method === 'GET' && r.route.endsWith('/requests/' + accepted.requestId);
  probe.traffic.fault = { kind: 'denied', match: requestRoute };
  const denied = await call('notebook_status', { notebookId, runId: originalArgs.runId });
  probe.traffic.fault = undefined;
  check(
    'Injected HTTP 401 preserves original request identity without replay',
    denied.state === 'unknown' &&
      denied.requestId === accepted.requestId &&
      posts() === 1 &&
      probe.requests.some((r) => r.injected === 'denied'),
    {
      denied,
      executePosts: posts(),
      limitation:
        'Injected denial on the actual remote request route; not an expired-password experiment',
    }
  );
  probe.traffic.fault = { kind: 'disconnect', match: requestRoute };
  const disconnected = await call('notebook_status', { notebookId, runId: originalArgs.runId });
  probe.traffic.fault = undefined;
  check(
    'Dropped HTTP reply preserves original request identity without replay',
    disconnected.state === 'unknown' &&
      disconnected.requestId === accepted.requestId &&
      posts() === 1,
    {
      disconnected,
      executePosts: posts(),
      limitation: 'Host observer disconnects the response; not a physical network outage',
    }
  );
  const native = await terminal(handle);
  const recovered = await call('notebook_status', { notebookId, runId: originalArgs.runId });
  check(
    'A fresh CLI process recovers the original terminal after transport failures',
    native.state === 'completed' &&
      recovered.state === 'completed' &&
      recovered.requestId === accepted.requestId &&
      JSON.stringify(recovered).includes('AUTH_ORIGINAL_RESULT 11') &&
      posts() === 1,
    { recovered, executePosts: posts() }
  );

  await edit(
    "reply_counter=globals().get('reply_counter',0)+1\nprint('LOST_REPLY_COUNTER',reply_counter)"
  );
  const lostArgs = await args('lost-reply-original');
  probe.traffic.fault = {
    kind: 'lost-reply',
    match: (r) => r.method === 'POST' && r.route.endsWith('/execute'),
  };
  const lost = await call('notebook_execute', lostArgs);
  probe.traffic.fault = undefined;
  const audit = probe.requests.find((r) => r.injected === 'lost-reply');
  if (!audit?.requestId) throw new Error('Observer did not capture actual remote acceptance');
  const executed = await terminal({ kernelId, requestId: audit.requestId });
  const repeated = await call('notebook_execute', lostArgs);
  check(
    'Lost accepted reply remains unknown and is never replayed by a new CLI process',
    lost.state === 'unknown' &&
      !lost.requestId &&
      repeated.state === 'unknown' &&
      !repeated.requestId &&
      posts() === 2 &&
      JSON.stringify(executed).includes('LOST_REPLY_COUNTER 1'),
    {
      lost,
      repeated,
      executed,
      executePosts: posts(),
      limitation: 'Observer-only request identity is not adopted into the CLI journal',
    }
  );

  await client.json('api/kernels/' + kernelId + '/restart', 'POST', {});
  let next;
  const deadline = Date.now() + 15000;
  do {
    next = await client.kernelInfo(kernelId);
    if (next.incarnation && next.incarnation !== incarnation.incarnation) break;
    await wait(150);
  } while (Date.now() < deadline);
  let refused = false;
  try {
    await call('notebook_execute', await args('after-native-restart'));
  } catch {
    refused = true;
  }
  check(
    'Owned kernel restart refuses silent continuation or replacement',
    refused &&
      next.kernelId === kernelId &&
      next.incarnation !== incarnation.incarnation &&
      posts() === 2,
    { originalIncarnation: incarnation, nextIncarnation: next, refused, executePosts: posts() }
  );
  report.jupyterRestart = {
    state: 'not_verified',
    reason:
      'Service restart is outside this API-only probe; no SSH or container operation is supported',
  };
} catch (error) {
  report.operationError = error.message.replaceAll(env.JUPYTERLAB_PASS, '[REDACTED]');
} finally {
  probe.traffic.fault = undefined;
  await probe.close();
  report.commands = probe.commands;
  const sessions = await client.json('api/sessions');
  for (const owned of sessions.filter(
    (s) => s.path === file && !before.sessions.some((x) => x.id === s.id)
  )) {
    if (kernelId && owned.kernel.id !== kernelId) {
      report.cleanupError = 'Owned Notebook kernel identity changed; cleanup refused';
      continue;
    }
    try {
      await client.json('api/sessions/' + owned.id, 'DELETE');
    } catch {
      report.cleanupError = 'Owned session cleanup failed';
    }
  }
  const after = {
    kernels: await client.json('api/kernels'),
    sessions: await client.json('api/sessions'),
  };
  report.originalResourcesPreserved = ['kernels', 'sessions'].every((kind) =>
    before[kind].every((item) => after[kind].some((x) => x.id === item.id))
  );
  report.resourceCounts = {
    kernels: [before.kernels.length, after.kernels.length],
    sessions: [before.sessions.length, after.sessions.length],
  };
  report.completed = !report.operationError && !report.cleanupError;
  report.requiredChecksPassed = report.checks.length === 5 && report.checks.every((c) => c.passed);
  report.finishedAt = new Date().toISOString();
  persist();
}
console.log(
  JSON.stringify({
    output: directory,
    completed: report.completed,
    requiredChecksPassed: report.requiredChecksPassed,
    checks: report.checks.length,
    resourceCounts: report.resourceCounts,
    error: report.operationError,
  })
);
if (!report.completed || !report.requiredChecksPassed || !report.originalResourcesPreserved)
  process.exitCode = 1;
