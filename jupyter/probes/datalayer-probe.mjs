import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';
import { lineChartSource } from './display-fixtures.mjs';
import {
  createCLIProbe,
  probeSource,
  probeAuth,
  probeConnection,
  probeKernel,
} from './cli-probe-client.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    output: { type: 'string' },
    'long-seconds': { type: 'string', default: '67' },
    'kernel-name': { type: 'string' },
  },
});
if (!values.output) {
  throw new Error('A new --output directory required');
}
const longSeconds = Number(values['long-seconds']);
if (!Number.isSafeInteger(longSeconds) || longSeconds < 2 || longSeconds > 120) {
  throw new Error('Invalid bounded background duration');
}
const directory = path.resolve(values.output);
fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
fs.mkdirSync(directory, { mode: 0o700 });
const auth = await probeAuth(values['env-file']);
if (!auth.baseUrl || !auth.secret) {
  throw new Error('Configured remote environment unavailable');
}
const client = new DatalayerJupyterClient({
  ...probeConnection(auth),
  allowInsecureHttp: true,
});
const project = path.join(directory, 'project');
fs.mkdirSync(project, { mode: 0o700 });
const probe = await createCLIProbe({ envFile: values['env-file'], project, directory: project });
const report = {
  source: probeSource(),
  startedAt: new Date().toISOString(),
  scope:
    'Configured remote Datalayer + independent public CLI process component acceptance; no production Feishu switch',
  checks: [],
  requests: [],
  project,
  ownedNotebooks: [],
};
const check = (name, passed, evidence) => {
  report.checks.push({ name, passed, evidence });
  persist();
};
const persist = () => {
  const data = JSON.stringify(report, null, 2);
  if (data.includes(auth.secret)) {
    throw new Error('Credential reached report');
  }
  fs.writeFileSync(path.join(directory, 'report.json'), data + '\n', { mode: 0o600 });
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalKernels = await client.json('api/kernels');
const originalSessions = await client.json('api/sessions');
let peer;
const createdSessions = [];
const call = probe.call;
const poll = async (notebookId, runId, seconds = 25) => {
  const deadline = Date.now() + seconds * 1000;
  let result;
  do {
    result = await call('notebook_status', { notebookId, runId });
    if (
      ['completed', 'failed', 'cancelled', 'unknown', 'rejected', 'input_required'].includes(
        result.state
      )
    ) {
      return result;
    }
    await wait(150);
  } while (Date.now() < deadline);
  throw new Error('Scratch execution exceeded its bounded wait');
};
try {
  report.kernel = await probeKernel(client, values['kernel-name']);
  report.initialize = await client.initialize();
  report.tools = (await client.listTools()).map((t) => t.name);
  try {
    await client.rpc('tasks/list');
    check('MCP Tasks protocol', true, {});
  } catch (error) {
    check('MCP Tasks protocol', false, { reason: error.message });
  }
  const notebook = `disclaude-datalayer-mvp-${randomUUID().slice(0, 8)}.ipynb`;
  const cells = [
    {
      id: 'mvp-heading',
      cell_type: 'markdown',
      metadata: {},
      source: '# Datalayer MVP\nIsolated remote acceptance Notebook.',
    },
    {
      id: 'mvp-params',
      cell_type: 'code',
      metadata: {},
      source: 'mvp_value = 2',
      execution_count: null,
      outputs: [],
    },
    {
      id: 'mvp-analysis',
      cell_type: 'code',
      metadata: {},
      source: 'print("MVP_RESULT", mvp_value * 3)',
      execution_count: null,
      outputs: [],
    },
    {
      id: 'mvp-human-note',
      cell_type: 'markdown',
      metadata: {},
      source: 'Human note: preserve this conclusion.',
    },
  ];
  const absent = await client.response(`api/contents/${notebook}`);
  if (absent.status !== 404) {
    throw new Error('Scratch Notebook ownership unavailable');
  }
  await absent.body?.cancel();
  await client.json(`api/contents/${notebook}`, 'PUT', {
    type: 'notebook',
    format: 'json',
    content: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: report.kernel,
      },
      cells,
    },
  });
  report.ownedNotebooks.push(notebook);
  report.notebookEntry = client.notebookEntry(notebook);
  if (values['kernel-name'])
    await client.json('api/sessions', 'POST', {
      path: notebook,
      name: notebook,
      type: 'notebook',
      kernel: { name: report.kernel.name },
    });
  const linked = await probe.command('link', undefined, ['--path', notebook]);
  const notebookId = linked.notebookId;
  report.notebookId = notebookId;
  const reference = linked;
  report.documentId = reference.documentId;
  peer = await client.openDocument(notebook, reference.documentId);
  peer.notebook.getCell(1).source = 'mvp_value = 17';
  peer.notebook.getCell(3).source = 'Human note: edited through an independent RTC participant.';
  await peer.flush();
  const live = await call('notebook_read_cell', { notebookId, cellId: 'mvp-params' });
  const disk = await client.json(`api/contents/${notebook}`);
  check('MVP reads unsaved RTC edit', live.source === 'mvp_value = 17', {
    liveSource: live.source,
    diskSource: disk.content.cells[1].source,
    confirmedUnsaved: disk.content.cells[1].source !== live.source,
  });
  const parameter = await call('notebook_read_cell', { notebookId, cellId: 'mvp-params' });
  report.finalParameterSource = parameter.source;
  const expected = Number(parameter.source.match(/^mvp_value = (\d+)$/)?.[1]);
  const args = {
    notebookId,
    cellId: 'mvp-params',
    expectedSourceHash: parameter.sourceHash,
    runId: 'mvp-parameters',
  };
  const accepted = await call('notebook_execute', args);
  report.ownedKernelId = (await client.json('api/sessions')).find(
    (s) => s.path === notebook
  )?.kernel.id;
  createdSessions.push(
    ...(await client.json('api/sessions')).filter(
      (s) => s.path === notebook && !originalSessions.some((x) => x.id === s.id)
    )
  );
  check('MVP submits to existing remote nbmodel queue', accepted.state === 'accepted', accepted);
  const parameterResult = await poll(notebookId, args.runId);
  check('Parameter cell executes', parameterResult.state === 'completed', parameterResult);
  const analysis = await call('notebook_read_cell', { notebookId, cellId: 'mvp-analysis' });
  const run = await call('notebook_execute', {
    notebookId,
    cellId: 'mvp-analysis',
    expectedSourceHash: analysis.sourceHash,
    runId: 'mvp-analysis',
  });
  const result = await poll(notebookId, 'mvp-analysis');
  check(
    'Persistent remote kernel uses edited parameter',
    result.state === 'completed' && JSON.stringify(result).includes(String(expected * 3)),
    result
  );
  const repeated = await call('notebook_execute', args);
  check(
    'Repeated original runId preserves the original request',
    repeated.requestId === accepted.requestId && repeated.state === 'completed',
    { original: accepted, repeated }
  );
  const rawRepeat = await client.observe({
    kernelId: report.ownedKernelId,
    requestId: run.requestId,
  });
  check('Upstream terminal GET is repeatable', rawRepeat.state === 'completed', rawRepeat);
  const recovered = await call('notebook_status', { notebookId, runId: 'mvp-analysis' });
  check(
    'A fresh CLI process recovers the cached original result',
    recovered.state === 'completed' && JSON.stringify(recovered).includes(String(expected * 3)),
    recovered
  );
  await call('notebook_insert_cell', {
    notebookId,
    cellId: 'mvp-plot',
    beforeCellId: '',
    cellType: 'code',
    source: lineChartSource,
  });
  const plot = await call('notebook_read_cell', { notebookId, cellId: 'mvp-plot' });
  await call('notebook_execute', {
    notebookId,
    cellId: 'mvp-plot',
    expectedSourceHash: plot.sourceHash,
    runId: 'mvp-plot',
  });
  const plotted = await poll(notebookId, 'mvp-plot');
  const plotCell = await call('notebook_read_cell', { notebookId, cellId: 'mvp-plot' });
  check(
    'Remote standard-library plot persists as image/png',
    plotted.state === 'completed' && JSON.stringify(plotCell.outputs).includes('image/png'),
    { result: plotted, outputs: plotCell.outputs }
  );
  const exported = await call('notebook_export', { notebookId });
  report.exports = exported;
  const html = await client.json(`api/contents/${exported.htmlPath}`);
  const snapshot = await client.json(`api/contents/${exported.notebookPath}`);
  fs.writeFileSync(
    path.join(directory, 'snapshot.ipynb'),
    JSON.stringify(snapshot.content, null, 2),
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(directory, 'report.html'), html.content, { mode: 0o600 });
  const pngOutput = snapshot.content.cells
    .find((c) => c.id === 'mvp-plot')
    ?.outputs?.find((o) => o.data?.['image/png']);
  if (pngOutput) {
    fs.writeFileSync(
      path.join(directory, 'chart.png'),
      Buffer.from(pngOutput.data['image/png'], 'base64'),
      { mode: 0o600 }
    );
  }
  const analysisText = snapshot.content.cells
    .find((c) => c.id === 'mvp-analysis')
    ?.outputs?.filter((o) => o.output_type === 'stream')
    .map((o) => (Array.isArray(o.text) ? o.text.join('') : o.text))
    .join('');
  check(
    'HTML and Notebook export share the captured calculation/chart',
    html.content.includes(exported.revision) &&
      html.content.includes('data:image/png;base64,') &&
      analysisText?.trim() === `MVP_RESULT ${expected * 3}`,
    {
      revision: exported.revision,
      paths: [exported.htmlPath, exported.notebookPath],
      pngPresent: !!pngOutput,
      analysisText,
    }
  );
  await call('notebook_insert_cell', {
    notebookId,
    cellId: 'mvp-background',
    beforeCellId: '',
    cellType: 'code',
    source: `import time\ntime.sleep(${longSeconds})\nprint("MVP_BACKGROUND_FINISHED")`,
  });
  const background = await call('notebook_read_cell', { notebookId, cellId: 'mvp-background' });
  const backgroundRun = await call('notebook_execute', {
    notebookId,
    cellId: 'mvp-background',
    expectedSourceHash: background.sourceHash,
    runId: 'mvp-background',
  });
  peer.close();
  peer = undefined;
  report.phase = 'background_execution_without_document_clients';
  persist();
  console.log(JSON.stringify({ phase: report.phase, durationSeconds: longSeconds }));
  await wait((longSeconds + 2) * 1000);
  const detached = await client.observe({
    kernelId: report.ownedKernelId,
    requestId: backgroundRun.requestId,
  });
  const saved = await client.json(`api/contents/${notebook}`);
  const savedCell = saved.content.cells.find((c) => c.id === 'mvp-background');
  check(
    'Background run survives all document clients closing',
    detached.state === 'completed',
    detached
  );
  check(
    'Background outputs persist after all document clients close',
    JSON.stringify(savedCell?.outputs).includes('MVP_BACKGROUND_FINISHED'),
    { durationSeconds: longSeconds, outputs: savedCell?.outputs }
  );
  // The preceding direct GET consumed the result. It was intentionally not entered in the journal.
  const afterExternalRead = await call('notebook_status', { notebookId, runId: 'mvp-background' });
  check(
    'Original request remains queryable after another consumer reads it',
    afterExternalRead.state === 'completed',
    afterExternalRead
  );
  await call('notebook_insert_cell', {
    notebookId,
    cellId: 'mvp-stop',
    beforeCellId: '',
    cellType: 'code',
    source: 'import time\ntime.sleep(10)\nprint("UNEXPECTED_STOP_COMPLETION")',
  });
  const stoppable = await call('notebook_read_cell', { notebookId, cellId: 'mvp-stop' });
  await call('notebook_execute', {
    notebookId,
    cellId: 'mvp-stop',
    expectedSourceHash: stoppable.sourceHash,
    runId: 'mvp-stop',
  });
  await wait(200);
  const stop = await call('notebook_stop', { notebookId, runId: 'mvp-stop' });
  const stopAccepted = stop.state === 'cancelled' && stop.stopConfirmed === true;
  check('Native nbmodel request-scoped cancellation', stopAccepted, stop);
  if (stopAccepted) {
    const stopped = await poll(notebookId, 'mvp-stop');
    check(
      'Native request cancellation is confirmed on the original run',
      stopped.state === 'cancelled',
      stopped
    );
  }
  // A second interrupt needs its own run: interrupting the first run twice can
  // interrupt IPython's error handling and obscure its KeyboardInterrupt reply.
  const readyDeadline = Date.now() + 10000;
  while (Date.now() < readyDeadline) {
    const state = await client.json(`api/kernels/${report.ownedKernelId}`);
    if (state.execution_state === 'idle') break;
    await wait(100);
  }
  await call('notebook_insert_cell', {
    notebookId,
    cellId: 'mvp-kernel-interrupt',
    beforeCellId: '',
    cellType: 'code',
    source: 'import time\ntime.sleep(10)\nprint("UNEXPECTED_INTERRUPT_COMPLETION")',
  });
  const interruptCell = await call('notebook_read_cell', {
    notebookId,
    cellId: 'mvp-kernel-interrupt',
  });
  await call('notebook_execute', {
    notebookId,
    cellId: interruptCell.cellId,
    expectedSourceHash: interruptCell.sourceHash,
    runId: 'mvp-kernel-interrupt',
  });
  await wait(200);
  // Explicit kernel-wide interrupt is permitted only on the verified scratch kernel.
  await client.json(`api/kernels/${report.ownedKernelId}/interrupt`, 'POST', {});
  const interrupted = await poll(notebookId, 'mvp-kernel-interrupt');
  check(
    'Explicit API interrupt of owned scratch kernel is confirmed (not a CLI command)',
    interrupted.state === 'cancelled',
    interrupted
  );
  const human = await call('notebook_read_cell', { notebookId, cellId: 'mvp-human-note' });
  check('Human Markdown remains preserved', human.source.includes('independent RTC participant'), {
    source: human.source,
  });
  const descriptor = fs.readFileSync(path.join(project, '.jupyter', 'config.json'), 'utf8');
  check(
    'Credentials stay outside Project and CLI outputs',
    !descriptor.includes(auth.secret) &&
      !descriptor.includes(auth.baseUrl) &&
      !JSON.stringify(probe.commands).includes(auth.secret),
    {}
  );
  check(
    'Notebook operations used independent CLI processes',
    probe.commands.length > 10 &&
      new Set(probe.commands.map((c) => c.pid)).size === probe.commands.length,
    { commands: probe.commands.length, pids: probe.commands.map((c) => c.pid) }
  );
  report.commands = probe.commands;
  report.completed = true;
} catch (error) {
  report.completed = false;
  report.error = error.message.replaceAll(auth.secret, '[REDACTED]');
} finally {
  peer?.close();
  await probe.close();
  const remaining = await client.json('api/sessions');
  for (const owned of remaining.filter(
    (s) =>
      report.ownedNotebooks.includes(s.path) &&
      !originalSessions.some((original) => original.id === s.id)
  )) {
    if (!createdSessions.some((created) => created.id === owned.id)) {
      createdSessions.push(owned);
    }
  }
  for (const created of createdSessions) {
    try {
      await client.json(`api/sessions/${created.id}`, 'DELETE');
    } catch {
      report.cleanupFailed = true;
    }
  }
  const kernels = await client.json('api/kernels');
  const sessions = await client.json('api/sessions');
  report.originalKernelsPreserved = originalKernels.every((k) =>
    kernels.some((after) => after.id === k.id)
  );
  report.originalSessionsPreserved = originalSessions.every((s) =>
    sessions.some((after) => after.id === s.id)
  );
  report.resourceCounts = {
    kernels: [originalKernels.length, kernels.length],
    sessions: [originalSessions.length, sessions.length],
  };
  report.finishedAt = new Date().toISOString();
  report.requiredChecksPassed = report.checks
    .filter((check) => check.name !== 'MCP Tasks protocol')
    .every((check) => check.passed);
  persist();
  console.log(
    JSON.stringify({
      output: directory,
      completed: report.completed,
      checks: report.checks.map((c) => ({ name: c.name, passed: c.passed })),
      resourceCounts: report.resourceCounts,
      error: report.error,
    })
  );
  if (
    !report.completed ||
    !report.requiredChecksPassed ||
    !report.originalKernelsPreserved ||
    !report.originalSessionsPreserved ||
    report.cleanupFailed
  ) {
    process.exitCode = 1;
  }
}
