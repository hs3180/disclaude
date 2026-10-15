// Opt-in research probe. The official SDK owns profile startup, stdio and teardown.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({
  options: {
    'sdk-root': { type: 'string' },
    config: { type: 'string' },
    agent: { type: 'string' },
    output: { type: 'string' },
    mode: { type: 'string' },
  },
});
for (const name of ['sdk-root', 'config', 'agent', 'output']) {
  assert.ok(values[name], `Required: --${name}`);
}
const sdkRequire = createRequire(path.join(path.resolve(values['sdk-root']), 'package.json'));
const sdkManifest = sdkRequire('@deepseek-ai/dsh-sdk-client/package.json');
assert.equal(sdkManifest.version, '0.1.2-rc.1', 'Use the pinned SDK version');
const { DeepSeekHarness } = await import(
  pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-sdk-client'))
);

process.env.DISCLAUDE_CONFIG_PATH = path.resolve(values.config);
process.env.LOG_LEVEL = 'fatal';
process.env.LOG_TO_FILE = 'false';
const { Config, applyGlobalEnv } = await import('../../packages/core/dist/index.js');
const { AgentFactory } = await import('../../packages/service/dist/agents/factory.js');
const { dshProcessEnv } =
  await import('../../packages/core/dist/sdk/providers/deepseek/dsh-environment.js');
applyGlobalEnv();
const agent = Config.getAgentPresets()[values.agent];
assert.equal(agent?.agentBackend, 'dsh', 'Select an existing named DSH agent');
const selected = AgentFactory.resolveConfig(agent);
assert.ok(selected.apiKey && selected.model && selected.apiBaseUrl);
assert.ok(['openai', 'anthropic'].includes(selected.apiProtocol));
const mode = values.mode ?? selected.mode ?? 'standard';
assert.ok(['minimal', 'standard'].includes(mode));

// A fresh directory prevents accidental reuse/replay and contains every generated file.
const root = path.resolve(values.output);
await fs.mkdir(root, { mode: 0o700 });
const home = path.join(root, 'home'),
  cwd = path.join(root, 'project');
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(cwd, { mode: 0o700 });
const fact = `SDK_${randomUUID()}`,
  chinese = `中文_SDK_${randomUUID()}`;
await fs.writeFile(path.join(cwd, '材料.txt'), fact, { mode: 0o600 });
const provider = 'disclaude-sdk-probe';
const connection = {
  providers: {
    [provider]: {
      api: selected.apiProtocol === 'openai' ? 'openai-completions' : 'anthropic-messages',
      baseURL: selected.apiBaseUrl,
      apiKeyEnv: 'DISCLAUDE_DSH_API_KEY',
      models: [{ id: selected.model, name: selected.model, input: ['text'] }],
    },
  },
};
const tools = {
  id: 'disclaude-sdk-probe-tools',
  name: new URL('./sdk-probe-tools.mjs', import.meta.url).href,
  config: { material: path.join(cwd, '材料.txt') },
};
const patch = path.join(root, 'probe.patch.json');
await fs.writeFile(
  patch,
  JSON.stringify(
    mode === 'standard'
      ? [{ id: 'llm-pi-ai', config: connection }, { insert: [tools] }]
      : [
          {
            insert: [
              {
                id: 'probe-api',
                name: pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).href,
                config: connection,
              },
              tools,
            ],
          },
        ]
  ),
  { mode: 0o600 }
);

// No custom worker, boot tree, transport or private SDK access.
const harness = new DeepSeekHarness({
  profile: mode === 'minimal' ? 'sdk-minimal' : 'sdk',
  patches: [patch],
  cwd,
  processCwd: cwd,
  dshHome: home,
  provider,
  model: selected.model,
  env: dshProcessEnv({
    ...process.env,
    ...selected.env,
    PATH: '/usr/bin:/bin',
    DEEPSEEK_API_KEY: undefined,
    DSH_HOME: home,
    ['DISCLAUDE_DSH_API_KEY']: selected.apiKey,
  }),
  initializeTimeoutMs: 15_000,
  requestTimeoutMs: 15_000,
});
const report = {
  sdkVersion: sdkManifest.version,
  node: process.version,
  protocol: selected.apiProtocol,
  model: selected.model,
  mode,
  startedAt: new Date().toISOString(),
  modelInputs: 0,
  passed: false,
  boundary: 'Isolated official SDK and native tool plugin; no Feishu or production changes.',
};
let timer;
try {
  await harness.start();
  report.modelInputs++;
  const result = await Promise.race([
    harness.run(
      `Call read_owned_material exactly once. Then use bash to run printf '%s\\n' '${chinese}'. ` +
        'Use no other tools. Reply with the returned fact. Do not include private reasoning.'
    ),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Probe deadline')), 120_000);
    }),
  ]);
  const calls = result.events.filter((event) => event.type === 'tool/call');
  const results = result.events.filter((event) => event.type === 'tool/result');
  report.sessionId = result.sessionId;
  report.toolNames = calls.map((event) => event.data.name);
  report.hostCalls = report.toolNames.filter((name) => name === 'read_owned_material').length;
  report.nativeChineseBash =
    calls.some((event) => event.data.name.toLowerCase() === 'bash') &&
    results.some((event) => JSON.stringify(event.data.message).includes(chinese));
  report.toolErrors = results.filter((event) =>
    event.data.message.content.some((block) => block.isError)
  ).length;
  report.finalContainsFact = result.finalResponse.includes(fact);
  report.terminal = result.events
    .filter((event) => event.type === 'turn/end')
    .map((event) => event.data.reason.kind);
  report.passed =
    report.hostCalls === 1 &&
    report.nativeChineseBash &&
    !report.toolErrors &&
    report.finalContainsFact &&
    report.terminal.length === 1 &&
    report.terminal[0] === 'completed';
} catch (error) {
  report.failure = error.name; // SDK errors may contain credentials or private stderr.
} finally {
  clearTimeout(timer);
  try {
    await harness.close();
    report.sdkCloseCompleted = true;
  } catch (error) {
    report.shutdownFailure = error.name;
    report.passed = false;
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
if (!report.passed) process.exitCode = 1;
