import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JupyterCoordinatorClient } from '../../packages/core/dist/jupyter/coordinator-client.js';

// Opt-in: the native DSH adapter is independently reviewed in #5244. This
// composes exact checkouts without sharing workspace node_modules directories.
const { values } = parseArgs({
  options: {
    'dsh-checkout': { type: 'string' },
    'oauth-auth-file': { type: 'string' },
    model: { type: 'string' },
    binary: { type: 'string', default: 'dsh' },
    'server-url': { type: 'string' },
    notebook: { type: 'string' },
    output: { type: 'string' },
    'host-session': { type: 'boolean', default: false },
    'config-file': { type: 'string' },
    'connection-id': { type: 'string' },
    'env-file': { type: 'string' },
    'project-dir': { type: 'string' },
  },
});
for (const key of ['dsh-checkout', 'oauth-auth-file', 'model', 'notebook', 'output']) {
  if (!values[key]) throw new Error(`Explicit --${key} required`);
}
const token = process.env.DISCLAUDE_JUPYTER_PROBE_TOKEN;
delete process.env.DISCLAUDE_JUPYTER_PROBE_TOKEN;
const configured = !!values['config-file'];
if (values.model.toLowerCase().includes('astra'))
  throw new Error('Astra is not permitted for this acceptance probe');
if (configured) {
  if (!values['connection-id'] || !values['project-dir'] || values['server-url'] || token)
    throw new Error(
      'Configured mode requires connection-id/project-dir and no owned-server URL/token'
    );
  if (
    !values.notebook.endsWith('.ipynb') ||
    values.notebook.startsWith('/') ||
    values.notebook.includes('\\') ||
    values.notebook.split('/').some((x) => !x || x === '..' || x === '.')
  )
    throw new Error('Configured acceptance requires a relative scratch Notebook path');
  values['host-session'] = true;
} else if (
  !token ||
  !values['server-url'] ||
  values['connection-id'] ||
  values['env-file'] ||
  values['project-dir']
) {
  throw new Error('Owned mode requires its explicit server URL/token and no host catalog options');
}
const secrets = [token].filter(Boolean);
const sanitize = (value) =>
  secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkout = path.resolve(values['dsh-checkout']);
const { DeepSeekHarnessProvider } = await import(
  pathToFileURL(path.join(checkout, 'packages/core/dist/sdk/providers/deepseek/provider.js'))
);
const { createNotebookTools } = await import(
  pathToFileURL(path.join(checkout, 'packages/core/dist/jupyter/notebook-tools.js'))
);
const reportPath = path.resolve(values.output);
await fs.writeFile(reportPath, '{"state":"starting"}\n', { flag: 'wx', mode: 0o600 });
let owned;
let dshHome;
let cwd;
const run = promisify(execFile);
const report = {
  state: 'failed',
  scope: configured
    ? 'configured-server Service-owned DSH native probe; not Feishu/native UI acceptance'
    : 'real DSH native Notebook tools over managed Jupyter ports',
  notebookProduct: 'not_executed',
  feishuProduct: 'not_executed',
  startedAt: new Date().toISOString(),
  harness: 'DSH',
  provider: 'openai-codex',
  model: values.model,
  reasoningEffort: 'low',
  phases: [],
  calls: [],
  nodeVersion: process.version,
  mode: configured ? 'configured' : 'owned',
  modelStarted: false,
  notebookOpened: false,
  ownedRootCreated: false,
};
const providers = [];
const diagnostics = [];
let hostSession;
let createHostSession;
let notebookAlias;
let access;
let client;
let connections;
const modelEnvironment = { ...process.env, JUPYTERLAB_PASS: undefined, JUPYTERLAB_HOST: undefined };
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
  report.backendSource = await sourceState(sourceDirectory, [
    'jupyter',
    'packages/core/src/jupyter',
    'packages/core/package.json',
    'package-lock.json',
    'tests/jupyter/coordinator-probe.py',
    'tests/jupyter/dsh-notebook-probe.mjs',
  ]);
  if (configured) {
    const { JupyterConnections } = await import(
      pathToFileURL(path.join(checkout, 'packages/service/dist/jupyter/connections.js'))
    );
    const environment = {
      ...process.env,
      ...(values['env-file']
        ? parseEnv(await fs.readFile(path.resolve(values['env-file']), 'utf8'))
        : {}),
    };
    connections = new JupyterConnections(path.resolve(values['config-file']), () => environment);
    // No model, Project write, Notebook open, control claim, kernel operation
    // or temporary root before the configured-server capability gate.
    report.configuredInspection = await connections.inspect(values['connection-id']);
    if (report.configuredInspection.coordinator !== 'available') {
      const error = new Error(
        'Configured Jupyter is authenticated but its Notebook coordinator is missing'
      );
      error.code = 'coordinator_missing';
      throw error;
    }
    const definitions = JSON.parse(
      await fs.readFile(path.resolve(values['config-file']), 'utf8')
    ).connections;
    const selected = definitions.find((item) => item.id === values['connection-id']);
    const key = selected.passwordEnv ?? selected.authorizationEnv;
    const file = selected.passwordFile ?? selected.authorizationFile;
    const credential = key ? environment[key] : await fs.readFile(file, 'utf8');
    if (credential) {
      secrets.push(credential);
      if (credential.trim()) secrets.push(credential.trim());
    }
    connections.redactEnvironment(modelEnvironment);
    const project = await fs.lstat(path.resolve(values['project-dir']));
    if (!project.isDirectory() || project.isSymbolicLink())
      throw new Error('Configured acceptance requires an existing dedicated Project directory');
    client = await connections.use(
      values['connection-id'],
      report.configuredInspection.status.serverNamespace,
      async (connected) => connected
    );
    report.projectPreserved = true;
  } else {
    client = new JupyterCoordinatorClient({
      baseUrl: values['server-url'],
      connectionId: 'owned-dsh-probe',
      authorization: async () => 'token ' + token,
    });
  }
  report.dshVersion = (await run(values.binary, ['--version'])).stdout.trim();
  if (report.dshVersion !== '0.1.2-rc.1') throw new Error('Expected DSH 0.1.2-rc.1');
  let auth;
  try {
    auth = JSON.parse(await fs.readFile(path.resolve(values['oauth-auth-file']), 'utf8'));
  } catch {
    throw new Error('Existing OAuth auth file could not be verified');
  }
  access = auth.tokens?.access_token;
  if (!access) throw new Error('Existing OAuth access credential unavailable');
  secrets.push(access);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
  } catch {
    throw new Error('Existing OAuth access credential could not be verified');
  }
  if (
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 < Date.now() + 15 * 60_000
  )
    throw new Error('Access credential near expiry; no refresh attempted');
  owned = await fs.mkdtemp(path.join(os.tmpdir(), 'disclaude-dsh-notebook-'));
  dshHome = path.join(owned, 'dsh');
  cwd = configured ? await fs.realpath(values['project-dir']) : path.join(owned, 'project');
  await fs.mkdir(dshHome, { mode: 0o700 });
  if (!configured) await fs.mkdir(cwd, { mode: 0o700 });
  report.ownedRoot = owned;
  report.ownedRootCreated = true;
  report.projectDirectory = cwd;
  const route = path.join(dshHome, 'route.patch.yml');
  await fs.writeFile(
    route,
    '- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        apiKeyEnv: DISCLAUDE_DSH_PROBE_ACCESS\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n- id: session-persistence-jsonl\n  config:\n    root: ' +
      JSON.stringify(path.join(dshHome, 'sessions')) +
      '\n    compression: none\n- id: session-telemetry-otel\n  disabled: true\n',
    { mode: 0o600 }
  );
  const notebook = await client.openNotebook(values.notebook);
  report.notebookOpened = true;
  const previous = await client.currentController(notebook);
  let authority;
  if (values['host-session']) {
    const { NotebookAgentSession } = await import(
      pathToFileURL(path.join(checkout, 'packages/service/dist/jupyter/agent-session.js'))
    );
    const { JupyterConnections } = await import(
      pathToFileURL(path.join(checkout, 'packages/service/dist/jupyter/connections.js'))
    );
    const { JupyterProjectConfigStore } = await import(
      pathToFileURL(path.join(checkout, 'packages/service/dist/jupyter/project-config-store.js'))
    );
    const { NotebookRunStore } = await import(
      pathToFileURL(path.join(checkout, 'packages/service/dist/jupyter/run-store.js'))
    );
    if (!configured) {
      const host = path.join(owned, 'host');
      await fs.mkdir(host, { mode: 0o700 });
      const authorizationFile = path.join(host, 'authorization');
      await fs.writeFile(authorizationFile, 'token ' + token, { mode: 0o600 });
      const configFile = path.join(host, 'connections.json');
      await fs.writeFile(
        configFile,
        JSON.stringify({
          version: 1,
          connections: [
            {
              id: notebook.identity.connectionId,
              baseUrl: values['server-url'],
              authorizationFile,
            },
          ],
        }),
        { mode: 0o600 }
      );
      connections = new JupyterConnections(configFile, () => ({}));
    }
    client = await connections.use(
      notebook.identity.connectionId,
      notebook.identity.serverNamespace,
      async (connected) => connected
    );
    const records = new NotebookRunStore(cwd, 'real-notebook-probe');
    const store = new JupyterProjectConfigStore(cwd);
    const refs = store.listNotebookReferences();
    if (
      configured &&
      (!refs.ok ||
        refs.data.some(
          (ref) =>
            ref.connectionId !== notebook.identity.connectionId ||
            ref.serverNamespace !== notebook.identity.serverNamespace ||
            (ref.documentId
              ? ref.documentId !== notebook.identity.documentId
              : ref.contentPath !== notebook.contentPath)
        ))
    )
      throw new Error('Dedicated Project already references a different Notebook');
    if (configured && previous && previous.ownerId !== records.ownerId())
      throw new Error('Configured Notebook has another controller; explicit handoff is required');
    authority = await client.claimControl(notebook, records.ownerId(), previous?.generation ?? 0);
    notebookAlias = createHash('sha256')
      .update(
        JSON.stringify([
          notebook.identity.connectionId,
          notebook.identity.serverNamespace,
          notebook.identity.documentId,
        ])
      )
      .digest('hex');
    records.saveLease(notebookAlias, authority);
    const linked = store.linkNotebook({
      ...notebook.identity,
      contentPath: notebook.contentPath,
    });
    if (!linked.ok) throw new Error('Owned Project Notebook reference could not be saved');
    createHostSession = () =>
      new NotebookAgentSession(
        { workingDir: cwd, conversationKey: 'real-notebook-probe', currentWorkingDir: () => cwd },
        connections
      );
    hostSession = createHostSession();
    report.scope = configured
      ? 'real Service-owned native Notebook capabilities over DSH and configured Jupyter; not Feishu/native UI acceptance'
      : 'real Service-owned native Notebook capabilities over DSH and managed Jupyter';
    report.hostSource = await sourceState(checkout, [
      'packages/service/src/jupyter',
      'packages/service/src/agents/chat-agent.ts',
      'packages/service/src/chat-session-pool.ts',
      'packages/service/src/cli-main.ts',
    ]);
  } else {
    authority = await client.claimControl(
      notebook,
      'dsh-probe-' + randomUUID(),
      previous?.generation ?? 0
    );
  }
  report.notebook = notebook;
  const humanNote = await client.readCell(notebook, 'human-note');
  let tools = (
    hostSession?.tools ??
    createNotebookTools({
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
    })
  ).map((tool) => ({
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
      env: { ...modelEnvironment, DEEPSEEK_API_KEY: undefined, DISCLAUDE_DSH_PROBE_ACCESS: access },
    });
    providers.push(provider);
    return provider;
  };
  const options = {
    cwd,
    sessionKey: 'real-notebook-probe',
    settingSources: [],
    nativeTools: tools,
    allowedTools: tools.map((tool) => tool.name),
    disallowedTools: ['CronCreate'],
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
      yield {
        role: 'user',
        content:
          prompt +
          (hostSession
            ? '\nNotebook alias: ' + notebookAlias + '\n' + (await hostSession.messageContext())
            : ''),
      };
    }
    report.modelStarted = true;
    report.notebookProduct = 'component_probe_only';
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
  if (hostSession) {
    hostSession.dispose();
    hostSession = createHostSession();
    // Native wrappers resolve the current host instance on every invocation.
    tools = tools.map((tool) => ({
      ...tool,
      execute: async (args, context) => {
        const record = {
          tool: tool.name,
          input: args,
          invocationObserved: !!context.invocationId,
          startedAt: new Date().toISOString(),
        };
        report.calls.push(record);
        const currentTool = hostSession.tools.find((item) => item.name === tool.name);
        record.output = await currentTool.execute(args, context);
        record.finishedAt = new Date().toISOString();
        return record.output;
      },
    }));
    options.nativeTools = tools;
  }
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
  if (hostSession) {
    const background = await collect(
      resumedProvider,
      'Service keeps a submitted Notebook run after inference ends',
      'Read long-cell, change time.sleep(30) to time.sleep(300), run its applied snapshot. Query only until its output shows RUNNING, then finish this response immediately with its runId. Leave that run executing for the host stop action. Do not stop it yourself or wait until terminal.'
    );
    const backgroundRun = background.calls.find(
      (call) => call.tool === 'notebook_run_cell' && call.output?.state === 'accepted'
    )?.output.handle;
    if (!backgroundRun) throw new Error('Service background run was not submitted');
    const beforeStop = await client.getStatus(notebook, backgroundRun.runId);
    if (beforeStop.state !== 'running')
      throw new Error('Service background run was not active after inference ended');
    const hostStop = await hostSession.stop();
    const hostStatus = await client.getStatus(notebook, backgroundRun.runId);
    if (
      !hostStop.some((item) => item.runId === backgroundRun.runId && item.state === 'cancelled') ||
      hostStatus.state !== 'cancelled' ||
      !hostStatus.details?.kernelIdleConfirmed
    ) {
      throw new Error('Service owner stop did not reach confirmed kernel cancellation');
    }
    background.state = 'passed';
    report.hostStop = { observations: hostStop, status: hostStatus };
    hostSession.dispose();
    hostSession = createHostSession();
    const hostRecovery = await collect(
      resumedProvider,
      'new Service host continues after owner stop',
      'Query the preceding exact runId first and verify cancellation. Then read short-cell, change its source to print("AFTER_HOST_STOP", dsh_value), run the applied snapshot and poll until terminal. Report the actual output; do not restart the kernel.'
    );
    if (
      !hostRecovery.calls.some(
        (call) =>
          call.tool === 'notebook_execution_status' &&
          JSON.stringify(call.output).includes('AFTER_HOST_STOP 7302')
      )
    ) {
      throw new Error('Service host post-stop kernel continuation failed');
    }
    hostRecovery.state = 'passed';
  }
  const handles = report.calls
    .filter((call) => call.tool === 'notebook_run_cell' && call.output?.state === 'accepted')
    .map((call) => call.output.handle);
  const kernelIdentities = new Set(
    handles.map((handle) =>
      JSON.stringify([
        handle.notebook.identity.connectionId,
        handle.notebook.identity.serverNamespace,
        handle.notebook.identity.documentId,
        handle.kernelId,
        handle.kernelIncarnation,
      ])
    )
  );
  if (handles.length < (hostSession ? 6 : 4) || kernelIdentities.size !== 1)
    throw new Error('Native continuation did not retain the same Notebook/kernel incarnation');
  const afterHumanNote = await client.readCell(notebook, 'human-note');
  if (
    afterHumanNote.source !== humanNote.source ||
    report.calls.some(
      (call) =>
        call.tool === 'notebook_edit_cell' &&
        !['short-cell', 'long-cell'].includes(call.input.cellId)
    )
  )
    throw new Error('Native probe changed a cell outside its requested experiments');
  report.sameKernelIncarnationVerified = true;
  report.humanNotePreserved = true;
  report.state = 'passed';
} catch (error) {
  report.state = error?.code === 'coordinator_missing' ? 'blocked' : 'failed';
  report.error = sanitize(error instanceof Error ? error.message : String(error));
} finally {
  const cleanup = await Promise.allSettled(providers.map((provider) => provider.shutdown()));
  report.providerCleanup = cleanup.map((result) => result.status);
  if (hostSession) {
    try {
      report.cleanupOwnerStop = await hostSession.stop();
      if (
        report.cleanupOwnerStop.some((item) => ['unknown', 'ownership_lost'].includes(item.state))
      ) {
        report.state = 'failed';
        report.cleanupError = 'Configured Notebook owner stop could not be confirmed';
      }
    } catch {
      report.state = 'failed';
      report.cleanupError = 'Notebook owner stop failed; preserve and reconcile the original runs';
    }
  }
  if (cleanup.some((result) => result.status !== 'fulfilled')) report.state = 'failed';
  try {
    if (!providers.length) {
      report.nativeLogInspection = 'not_executed';
    } else {
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
        if (secrets.some((secret) => content.includes(secret)))
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
    }
  } catch (error) {
    report.nativeLogInspection = 'failed';
    report.inspectionError = error.message;
    report.state = 'failed';
  }
  report.finishedAt = new Date().toISOString();
  report.diagnostics = sanitize(diagnostics.join(''));
  if (owned && cleanup.every((result) => result.status === 'fulfilled')) {
    await fs.rm(owned, { recursive: true, force: true });
    report.ownedRootRemoved = true;
  }
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      report,
      (_key, value) => (typeof value === 'string' ? sanitize(value) : value),
      2
    ) + '\n',
    { mode: 0o600 }
  );
  console.log(
    JSON.stringify({
      state: report.state,
      error: report.error,
      mode: report.mode,
      modelStarted: report.modelStarted,
      notebookOpened: report.notebookOpened,
      ownedRootCreated: report.ownedRootCreated,
      phases: report.phases.map((phase) => ({ name: phase.name, state: phase.state })),
      notebookProduct: report.notebookProduct,
      ownedRootRemoved: report.ownedRootRemoved,
    })
  );
  if (report.state !== 'passed') process.exitCode = report.state === 'blocked' ? 2 : 1;
}
