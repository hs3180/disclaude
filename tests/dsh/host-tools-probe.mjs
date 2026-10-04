import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { DeepSeekHarnessProvider } from '../../packages/core/dist/sdk/providers/deepseek/provider.js';

// Explicit opt-in model probe. Build the workspace first; this never runs in unit CI.
const { values } = parseArgs({
  options: {
    binary: { type: 'string', default: 'dsh' },
    'oauth-auth-file': { type: 'string' },
    model: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.model || !values['oauth-auth-file'] || !values.output) {
  throw new Error(
    'Usage: node tests/dsh/host-tools-probe.mjs --oauth-auth-file <existing-auth.json> --model <explicit-model> --output <new-report.json> [--binary <dsh>]'
  );
}
const reportPath = path.resolve(values.output);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify({ state: 'starting' }) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'disclaude-dsh-native-model-'));
const report = {
  kind: 'real DSH native adapter component probe',
  notebookProduct: 'not_executed',
  startedAt: new Date().toISOString(),
  dshVersion: 'not_verified',
  nodeVersion: process.version,
  harness: 'DSH',
  provider: 'openai-codex',
  model: values.model,
  reasoningEffort: 'low',
  phases: [],
  ownedHome: home,
};
let access;
const providers = [];
const diagnostics = [];
let releaseOwnedWork = () => {};
try {
  const version = await promisify(execFile)(values.binary, ['--version']);
  report.dshVersion = version.stdout.trim();
  if (report.dshVersion !== '0.1.2-rc.1')
    throw new Error('This component probe is pinned to DSH 0.1.2-rc.1');
  const auth = JSON.parse(await fs.readFile(path.resolve(values['oauth-auth-file']), 'utf8'));
  access = auth.tokens?.access_token;
  if (!access) throw new Error('No existing access credential');
  const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
  if (claims.exp * 1000 < Date.now() + 15 * 60_000)
    throw new Error('Access credential is too close to expiry; no refresh attempted');
  const route = path.join(home, 'probe-route.patch.yml');
  await fs.writeFile(
    route,
    '- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        apiKeyEnv: DISCLAUDE_DSH_PROBE_ACCESS\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n- id: session-persistence-jsonl\n  config:\n    root: ' +
      JSON.stringify(path.join(home, 'sessions')) +
      '\n    compression: none\n- id: session-telemetry-otel\n  disabled: true\n',
    { mode: 0o600 }
  );
  const createProvider = () => {
    const provider = new DeepSeekHarnessProvider({
      binary: values.binary,
      dshHome: home,
      provider: 'openai-codex',
      args: ['--profile', 'sdk', '--patch', route],
      requestTimeoutMs: 60_000,
      env: { ...process.env, DEEPSEEK_API_KEY: undefined, DISCLAUDE_DSH_PROBE_ACCESS: access },
    });
    providers.push(provider);
    return provider;
  };
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const marker1 = 'DSH_NATIVE_FIRST_' + randomUUID();
  const marker2 = 'DSH_NATIVE_SECOND_' + randomUUID();
  const options = {
    cwd: home,
    sessionKey: 'native-component-probe',
    settingSources: [],
    disallowedTools: ['CronCreate'],
    stderr: (data) => {
      if (diagnostics.join('').length < 32_000) diagnostics.push(data);
    },
    model: values.model,
    reasoningEffort: 'low',
    systemPrompt:
      'This is a native tool integration check. Use only the supplied native tools. Report exact tool observations. Never invent a tool result.',
  };
  async function* input(prompt) {
    yield { role: 'user', content: prompt };
  }
  async function collect(query, phase) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      query.handle.cancel();
    }, 180_000);
    try {
      const events = [];
      for await (const event of query.iterator) events.push(event);
      phase.sessionId = query.handle.sessionId;
      phase.events = events.map((event) => ({
        type: event.type,
        content: event.content,
        metadata: event.metadata,
      }));
      if (timedOut) throw new Error('Component probe deadline exceeded');
      return events;
    } finally {
      clearTimeout(timer);
    }
  }
  let calls = 0;
  const readTool = (marker) => ({
    name: 'native_probe_read',
    description: 'Read an exact integration marker',
    inputSchema: schema,
    outputSchema: { type: 'object' },
    execute: async (_args, ctx) => {
      calls++;
      return { marker, call: calls, nativeInvocationObserved: !!ctx.invocationId };
    },
  });
  const firstPhase = { name: 'native structured tool', expectedMarker: marker1 };
  report.phases.push(firstPhase);
  const firstProvider = createProvider();
  const first = firstProvider.queryStream(
    input('Call native_probe_read exactly once, then report its marker.'),
    { ...options, allowedTools: ['native_probe_read'], tools: [readTool(marker1)] }
  );
  const firstEvents = await collect(first, firstPhase);
  const firstResult = firstEvents.find((event) => event.type === 'tool_result')?.metadata
    ?.toolOutput;
  if (firstResult?.marker !== marker1 || calls !== 1)
    throw new Error('First native canonical result was not preserved');
  firstPhase.state = 'passed';
  await firstProvider.shutdown();
  const resumedPhase = {
    name: 'new provider/process native Session resume',
    expectedMarker: marker2,
  };
  report.phases.push(resumedPhase);
  const resumedProvider = createProvider();
  const second = resumedProvider.queryStream(
    input(
      'Call native_probe_read once more. Report the exact previous marker from our preceding interaction and the new marker. If the previous marker is unavailable, say so.'
    ),
    { ...options, allowedTools: ['native_probe_read'], tools: [readTool(marker2)] }
  );
  const secondEvents = await collect(second, resumedPhase);
  const answer = secondEvents
    .filter((event) => event.type === 'text')
    .map((event) => event.content)
    .join('\n');
  if (
    second.handle.sessionId !== first.handle.sessionId ||
    calls !== 2 ||
    !answer.includes(marker1) ||
    !answer.includes(marker2)
  )
    throw new Error('Native resume did not retain the prior marker and execute the new tool');
  resumedPhase.state = 'passed';
  const cancelledPhase = {
    name: 'native cancel and owned tool quiescence',
    executionStop: 'not_confirmed',
  };
  report.phases.push(cancelledPhase);
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const ownedCleanup = new Promise((resolve) => {
    releaseOwnedWork = resolve;
  });
  const waitingTool = {
    name: 'native_probe_wait',
    description: 'Wait for the integration controller to cancel this owned task',
    inputSchema: schema,
    outputSchema: { type: 'object' },
    execute: async (_args, { signal }) => {
      cancelledPhase.toolStartedAt = new Date().toISOString();
      enter();
      await new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelledPhase.signalAt = new Date().toISOString();
            resolve();
          },
          { once: true }
        )
      );
      await ownedCleanup;
      cancelledPhase.cleanupAt = new Date().toISOString();
      return { state: 'quiescent', executionStop: 'not_confirmed' };
    },
  };
  const third = resumedProvider.queryStream(
    input('Call native_probe_wait exactly once. Wait for its result.'),
    { ...options, allowedTools: ['native_probe_wait'], tools: [waitingTool] }
  );
  const thirdEvents = collect(third, cancelledPhase);
  await Promise.race([
    entered,
    thirdEvents.then(() => {
      throw new Error('Model turn ended without the wait tool');
    }),
  ]);
  let acknowledged = false;
  const interruption = third.handle.interrupt().then(() => {
    acknowledged = true;
    cancelledPhase.ackAt = new Date().toISOString();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelledPhase.ackBeforeOwnedCleanup = acknowledged;
  releaseOwnedWork();
  await interruption;
  const stopped = await thirdEvents;
  if (
    !cancelledPhase.signalAt ||
    !cancelledPhase.cleanupAt ||
    cancelledPhase.ackBeforeOwnedCleanup ||
    !stopped.some((event) => event.metadata?.stopReason === 'interrupted')
  )
    throw new Error(
      'Cancellation did not wait for owned tool cleanup and confirm neutral interruption'
    );
  cancelledPhase.state = 'passed';
  const recoveryPhase = { name: 'native resume after cancelled turn' };
  report.phases.push(recoveryPhase);
  const recovery = resumedProvider.queryStream(
    input('Call native_probe_read exactly once and report the observed marker.'),
    { ...options, allowedTools: ['native_probe_read'], tools: [readTool(marker2)] }
  );
  const recoveryEvents = await collect(recovery, recoveryPhase);
  if (
    recovery.handle.sessionId !== first.handle.sessionId ||
    !recoveryEvents.some((event) => event.metadata?.toolOutput?.marker === marker2) ||
    calls !== 3
  )
    throw new Error('Native post-cancel continuation failed');
  recoveryPhase.state = 'passed';
  report.state = 'passed';
} catch (error) {
  report.state = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  releaseOwnedWork();
  const cleanup = await Promise.allSettled(providers.map((provider) => provider.shutdown()));
  report.providerCleanup = cleanup.map((result) => result.status);
  const sessionRoot = path.join(home, 'sessions');
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
    const names = await files(sessionRoot);
    report.sessionFiles = names;
    const events = [];
    for (const name of names.filter((name) => name.endsWith('.jsonl'))) {
      const text = await fs.readFile(name, 'utf8');
      if (access && text.includes(access))
        throw new Error('Access credential appeared in a native session log');
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const record = JSON.parse(line);
          events.push(record.event ?? record);
        } catch {}
      }
    }
    if (!events.length) throw new Error('No native session events were inspected');
    report.nativeEventTypes = [...new Set(events.map((event) => event.type))];
    report.nativeRouteEvidence = events
      .filter((event) => event.type === 'request/header')
      .map((event) => ({
        type: event.type,
        seq: event.seq,
        reason: event.data.reason,
        config: event.data.header.config,
      }));
    if (!report.nativeRouteEvidence.length)
      throw new Error('No native request headers were inspected');
    if (
      report.nativeRouteEvidence.some(
        (event) =>
          event.config.provider !== report.provider ||
          event.config.model !== report.model ||
          event.config.reasoningEffort !== report.reasoningEffort
      )
    )
      throw new Error('Native request route did not match the explicit acceptance model');
    report.nativeLogInspection = 'passed';
    report.nativeSessionEventCount = events.length;
    report.credentialInSessionLog = false;
  } catch (error) {
    report.nativeLogInspection = 'failed';
    report.sessionInspection = error.message;
    if (report.state === 'passed') {
      report.state = 'failed';
      report.error = 'Native log inspection failed: ' + error.message;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.diagnostics = diagnostics
    .join('')
    .replaceAll(access || 'UNUSED_SECRET_SENTINEL', '[REDACTED]');
  await fs.writeFile(
    reportPath,
    JSON.stringify(report, null, 2).replaceAll(access || 'UNUSED_SECRET_SENTINEL', '[REDACTED]') +
      '\n',
    { mode: 0o600 }
  );
  if (cleanup.every((result) => result.status === 'fulfilled')) {
    await fs.rm(home, { recursive: true, force: true });
    report.ownedHomeRemoved = true;
    await fs.writeFile(
      reportPath,
      JSON.stringify(report, null, 2).replaceAll(access || 'UNUSED_SECRET_SENTINEL', '[REDACTED]') +
        '\n',
      { mode: 0o600 }
    );
  }
  console.log(
    JSON.stringify({
      state: report.state,
      error: report.error,
      phases: report.phases.map((phase) => ({ name: phase.name, state: phase.state })),
      notebookProduct: report.notebookProduct,
      ownedHomeRemoved: report.ownedHomeRemoved,
    })
  );
  if (report.state !== 'passed') process.exitCode = 1;
}
