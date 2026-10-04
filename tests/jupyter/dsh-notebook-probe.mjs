import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { JupyterCoordinatorClient } from '../../packages/core/dist/jupyter/coordinator-client.js';

// Opt-in: use the merged DSH tool contract and record the exact checkout.
// Each checkout keeps its own workspace node_modules directory.
const { values } = parseArgs({
  options: {
    'dsh-checkout': { type: 'string' },
    'oauth-auth-file': { type: 'string' },
    model: { type: 'string' },
    binary: { type: 'string', default: 'dsh' },
    'server-url': { type: 'string' },
    notebook: { type: 'string' },
    output: { type: 'string' },
  },
});
for (const key of [
  'dsh-checkout',
  'oauth-auth-file',
  'model',
  'server-url',
  'notebook',
  'output',
]) {
  if (!values[key]) throw new Error(`Explicit --${key} required`);
}
const token = process.env.DISCLAUDE_JUPYTER_PROBE_TOKEN;
delete process.env.DISCLAUDE_JUPYTER_PROBE_TOKEN;
if (!token) throw new Error('Owned Jupyter probe authentication is required');
const checkout = path.resolve(values['dsh-checkout']);
const { DeepSeekHarnessProvider } = await import(
  pathToFileURL(path.join(checkout, 'packages/core/dist/sdk/providers/deepseek/provider.js'))
);
const { createNotebookTools } = await import(
  pathToFileURL(path.join(checkout, 'packages/core/dist/jupyter/notebook-tools.js'))
);
const reportPath = path.resolve(values.output);
await fs.writeFile(reportPath, '{"state":"starting"}\n', { flag: 'wx', mode: 0o600 });
const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'disclaude-dsh-notebook-'));
const dshHome = path.join(owned, 'dsh');
const cwd = path.join(owned, 'project');
await fs.mkdir(dshHome, { mode: 0o700 });
await fs.mkdir(cwd, { mode: 0o700 });
const run = promisify(execFile);
const report = {
  state: 'failed',
  scope: 'real DSH native Notebook tools over managed Jupyter ports',
  notebookProduct: 'component_probe_only',
  feishuProduct: 'not_executed',
  startedAt: new Date().toISOString(),
  harness: 'DSH',
  provider: 'openai-codex',
  model: values.model,
  reasoningEffort: 'low',
  phases: [],
  calls: [],
  nodeVersion: process.version,
  ownedRoot: owned,
};
const providers = [];
const diagnostics = [];
let access;
async function sourceState(directory, paths) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
  const status = (await run('git', ['status', '--porcelain'], { cwd: directory })).stdout.trim();
  const names = (
    await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths], {
      cwd: directory,
    })
  ).stdout
    .split('\n')
    .filter(Boolean)
    .sort();
  const fingerprint = createHash('sha256').update(head);
  for (const name of names)
    fingerprint.update(name + '\0').update(await fs.readFile(path.join(directory, name)));
  return { head, worktreeDirty: !!status, sourceFingerprintSha256: fingerprint.digest('hex') };
}
try {
  report.nativeSource = await sourceState(checkout, [
    'packages/core/src/sdk/providers/deepseek',
    'packages/core/src/jupyter',
    'packages/core/package.json',
    'package-lock.json',
  ]);
  report.backendSource = await sourceState(path.resolve(''), [
    'jupyter',
    'packages/core/src/jupyter',
    'packages/core/package.json',
    'package-lock.json',
    'tests/jupyter/coordinator-probe.py',
    'tests/jupyter/dsh-notebook-probe.mjs',
  ]);
  report.dshVersion = (await run(values.binary, ['--version'])).stdout.trim();
  if (report.dshVersion !== '0.1.2-rc.1') throw new Error('Expected DSH 0.1.2-rc.1');
  const auth = JSON.parse(await fs.readFile(path.resolve(values['oauth-auth-file']), 'utf8'));
  access = auth.tokens?.access_token;
  if (!access) throw new Error('Existing OAuth access credential unavailable');
  const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
  if (claims.exp * 1000 < Date.now() + 15 * 60_000)
    throw new Error('Access credential near expiry; no refresh attempted');
  const route = path.join(dshHome, 'route.patch.yml');
  await fs.writeFile(
    route,
    '- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        apiKeyEnv: DISCLAUDE_DSH_PROBE_ACCESS\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n- id: session-persistence-jsonl\n  config:\n    root: ' +
      JSON.stringify(path.join(dshHome, 'sessions')) +
      '\n    compression: none\n- id: session-telemetry-otel\n  disabled: true\n',
    { mode: 0o600 }
  );
  const client = new JupyterCoordinatorClient({
    baseUrl: values['server-url'],
    connectionId: 'owned-dsh-probe',
    authorization: async () => 'token ' + token,
  });
  const notebook = await client.openNotebook(values.notebook);
  const previous = await client.currentController(notebook);
  const authority = await client.claimControl(
    notebook,
    'dsh-probe-' + randomUUID(),
    previous?.generation ?? 0
  );
  report.notebook = notebook;
  const tools = createNotebookTools({
    notebook,
    documents: client,
    executions: client,
    controller: async () => {
      const current = await client.currentController(notebook);
      if (
        !current ||
        current.ownerId !== authority.ownerId ||
        current.generation !== authority.generation
      )
        throw new Error('DSH Notebook ownership lost');
      return current;
    },
    kernel: () => client.ensureKernel(notebook),
  }).map((tool) => ({
    ...tool,
    execute: async (args, context) => {
      const record = {
        tool: tool.name,
        input: args,
        invocationObserved: !!context.invocationId,
        startedAt: new Date().toISOString(),
      };
      report.calls.push(record);
      record.output = await tool.execute(args, context);
      record.finishedAt = new Date().toISOString();
      return record.output;
    },
  }));
  const createProvider = () => {
    const provider = new DeepSeekHarnessProvider({
      binary: values.binary,
      dshHome,
      provider: 'openai-codex',
      args: ['--profile', 'sdk', '--patch', route],
      requestTimeoutMs: 60_000,
      env: { ...process.env, DEEPSEEK_API_KEY: undefined, DISCLAUDE_DSH_PROBE_ACCESS: access },
    });
    providers.push(provider);
    return provider;
  };
  const options = {
    cwd,
    sessionKey: 'real-notebook-probe',
    settingSources: [],
    tools,
    model: values.model,
    reasoningEffort: 'low',
    systemPrompt:
      'Use the native Notebook tools to inspect, edit and execute the bound Notebook. Report actual observations. Never invent results. Accepted execution requires polling its runId. Never resubmit unknown work. Keep all other cells unchanged.',
    stderr: (data) => {
      if (diagnostics.join('').length < 32_000) diagnostics.push(data);
    },
  };
  async function collect(provider, name, prompt) {
    const phase = { name, startedAt: new Date().toISOString() };
    report.phases.push(phase);
    const before = report.calls.length;
    async function* input() {
      yield { role: 'user', content: prompt };
    }
    const query = provider.queryStream(input(), options);
    const timer = setTimeout(() => query.handle.cancel(), 180_000);
    const events = [];
    try {
      for await (const event of query.iterator) events.push(event);
      phase.sessionId = query.handle.sessionId;
      phase.answer = events
        .filter((event) => event.type === 'text')
        .map((event) => event.content)
        .join('\n');
      phase.eventTypes = events.map((event) => event.type);
      phase.canonicalToolResults = events
        .filter((event) => event.type === 'tool_result')
        .map((event) => event.metadata?.toolOutput);
      phase.calls = report.calls.slice(before);
      phase.finishedAt = new Date().toISOString();
      return phase;
    } finally {
      clearTimeout(timer);
    }
  }
  const nonce = 'DSH_NOTEBOOK_' + randomUUID();
  const firstProvider = createProvider();
  const first = await collect(
    firstProvider,
    'native Notebook read/edit/run',
    `Read short-cell. Set its source to exactly: dsh_value = 7301\nprint(${JSON.stringify(nonce)} + ':' + str(dsh_value))\nUse the fresh read revision/hash for editing, then the applied snapshot for running. Poll until terminal. Report the actual printed marker and runId.`
  );
  const firstRun = first.calls.find((call) => call.tool === 'notebook_run_cell')?.output?.handle;
  if (
    !firstRun ||
    !first.calls.some(
      (call) => call.tool === 'notebook_edit_cell' && call.output?.state === 'applied'
    ) ||
    !first.canonicalToolResults.some((result) => result?.state === 'completed')
  )
    throw new Error('Native read/edit/run did not reach canonical completion');
  const firstStatus = await client.getStatus(notebook, firstRun.runId);
  if (firstStatus.state !== 'completed' || !JSON.stringify(firstStatus).includes(nonce + ':7301'))
    throw new Error('Native first-run output was not observed');
  first.state = 'passed';
  await firstProvider.shutdown();
  const resumedProvider = createProvider();
  const resumed = await collect(
    resumedProvider,
    'new native process resumes the same Notebook session',
    'Use the previous runId from our preceding interaction to query its status first; do not rerun it. Then read short-cell, replace it with dsh_value += 1\nprint(dsh_value), run the applied snapshot and poll until terminal. Report the previous exact printed marker from memory and the new value.'
  );
  if (
    resumed.sessionId !== first.sessionId ||
    resumed.calls[0]?.tool !== 'notebook_execution_status' ||
    resumed.calls[0]?.input.runId !== firstRun.runId ||
    !resumed.answer.includes(nonce) ||
    !resumed.calls.some(
      (call) =>
        call.tool === 'notebook_execution_status' && JSON.stringify(call.output).includes('7302')
    )
  )
    throw new Error('Native session/Notebook continuation failed');
  resumed.state = 'passed';
  const stopped = await collect(
    resumedProvider,
    'native Notebook exact-run stop',
    'Read and run long-cell using its current snapshot. Poll its runId until its output summary shows RUNNING, then request stopping that same run with notebook_stop_execution. Poll until terminal; report the actual final state. Do not rerun this cell.'
  );
  const longRun = stopped.calls.find((call) => call.tool === 'notebook_run_cell')?.output?.handle;
  if (
    !longRun ||
    !stopped.calls.some(
      (call) => call.tool === 'notebook_stop_execution' && call.output?.state === 'requested'
    )
  )
    throw new Error('Native stop tool was not observed');
  const stopStatus = await client.getStatus(notebook, longRun.runId);
  if (stopStatus.state !== 'cancelled' || !stopStatus.details?.kernelIdleConfirmed)
    throw new Error('Native kernel stop did not reach confirmed cancellation');
  stopped.state = 'passed';
  const recovery = await collect(
    resumedProvider,
    'native session and kernel continue after stop',
    'Read short-cell, replace it with print("AFTER_STOP", dsh_value), run the fresh applied snapshot and poll until terminal. Keep long-cell unchanged. Report the observed output.'
  );
  if (
    recovery.sessionId !== first.sessionId ||
    !recovery.calls.some(
      (call) =>
        call.tool === 'notebook_execution_status' &&
        JSON.stringify(call.output).includes('AFTER_STOP 7302')
    )
  )
    throw new Error('Native post-stop continuation failed');
  recovery.state = 'passed';
  report.state = 'passed';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  const cleanup = await Promise.allSettled(providers.map((provider) => provider.shutdown()));
  report.providerCleanup = cleanup.map((result) => result.status);
  try {
    async function files(directory) {
      const result = [];
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...(await files(location)));
        else if (entry.isFile()) result.push(location);
      }
      return result;
    }
    const events = [];
    for (const file of (await files(path.join(dshHome, 'sessions'))).filter((file) =>
      file.endsWith('.jsonl')
    )) {
      const content = await fs.readFile(file, 'utf8');
      if ((access && content.includes(access)) || content.includes(token))
        throw new Error('Probe credential persisted in native history');
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const item = JSON.parse(line);
          events.push(item.event ?? item);
        } catch {}
      }
    }
    report.nativeSessionEventCount = events.length;
    report.nativeRouteEvidence = events
      .filter((event) => event.type === 'request/header')
      .map((event) => event.data.header.config);
    if (
      !events.length ||
      report.nativeRouteEvidence.length < report.phases.length ||
      report.nativeRouteEvidence.some(
        (config) =>
          config.provider !== report.provider ||
          config.model !== report.model ||
          config.reasoningEffort !== report.reasoningEffort
      )
    )
      throw new Error('Native model route evidence incomplete');
    report.nativeLogInspection = 'passed';
  } catch (error) {
    report.nativeLogInspection = 'failed';
    report.inspectionError = error.message;
    report.state = 'failed';
  }
  report.finishedAt = new Date().toISOString();
  report.diagnostics = diagnostics
    .join('')
    .replaceAll(access || 'UNUSED_SECRET_SENTINEL', '[REDACTED]')
    .replaceAll(token, '[REDACTED]');
  if (cleanup.every((result) => result.status === 'fulfilled')) {
    await fs.rm(owned, { recursive: true, force: true });
    report.ownedRootRemoved = true;
  }
  await fs.writeFile(
    reportPath,
    JSON.stringify(report, null, 2)
      .replaceAll(access || 'UNUSED_SECRET_SENTINEL', '[REDACTED]')
      .replaceAll(token, '[REDACTED]') + '\n',
    { mode: 0o600 }
  );
  console.log(
    JSON.stringify({
      state: report.state,
      error: report.error,
      phases: report.phases.map((phase) => ({ name: phase.name, state: phase.state })),
      notebookProduct: report.notebookProduct,
      ownedRootRemoved: report.ownedRootRemoved,
    })
  );
  if (report.state !== 'passed') process.exitCode = 1;
}
