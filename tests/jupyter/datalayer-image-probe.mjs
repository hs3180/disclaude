import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { DeepSeekHarnessProvider } from '../../packages/core/dist/sdk/providers/deepseek/provider.js';
import { JupyterConnections } from '../../packages/service/dist/jupyter/connections.js';
import { notebookSessionFactory } from '../../packages/service/dist/jupyter/agent-session.js';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    'oauth-auth-file': { type: 'string' },
    connections: { type: 'string' },
    project: { type: 'string' },
    'cell-id': { type: 'string' },
    'output-index': { type: 'string', default: '0' },
    model: { type: 'string' },
    binary: { type: 'string', default: 'dsh' },
    output: { type: 'string' },
  },
});
for (const key of [
  'env-file',
  'oauth-auth-file',
  'connections',
  'project',
  'cell-id',
  'model',
  'output',
]) {
  if (!values[key]) {
    throw new Error(`Explicit --${key} required`);
  }
}
if (values.model !== 'gpt-5.6-luna') {
  throw new Error('This acceptance uses the explicit gpt-5.6-luna override');
}
const root = path.resolve(values.output);
fs.mkdirSync(root, { mode: 0o700 });
const env = parseEnv(fs.readFileSync(values['env-file'], 'utf8'));
const access = JSON.parse(fs.readFileSync(values['oauth-auth-file'], 'utf8')).tokens?.access_token;
const expiry = access && JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp;
if (!access || !expiry || expiry * 1000 < Date.now() + 900000) {
  throw new Error('Existing OAuth credential unavailable or near expiry');
}
const secrets = [access, env.JUPYTERLAB_PASS].filter(Boolean);
const report = {
  startedAt: new Date().toISOString(),
  scope:
    'Real DSH read-only image observation of the owned configured core-probe line plot; no native UI/Feishu acceptance',
  model: values.model,
  calls: [],
  events: [],
};
const persist = () => {
  const data = JSON.stringify(report, null, 2);
  if (secrets.some((secret) => data.includes(secret))) {
    throw new Error('Credential reached evidence');
  }
  fs.writeFileSync(path.join(root, 'report.json'), data + '\n', { mode: 0o600 });
};
const connections = new JupyterConnections(values.connections, () => env);
const session = notebookSessionFactory(connections)({
  workingDir: values.project,
  currentWorkingDir: () => values.project,
  conversationKey: 'datalayer-image-observation',
});
if (!session) {
  throw new Error('Existing authorized Notebook session unavailable');
}
const overview = await session.tools
  .find((t) => t.name === 'notebook_list')
  .execute({}, { signal: new AbortController().signal });
if (overview.notebooks.length !== 1) {
  throw new Error('A single owned core-probe Notebook is required');
}
const target = {
  notebookId: overview.notebooks[0].notebookId,
  cellId: values['cell-id'],
  outputIndex: Number(values['output-index']),
};
const dshHome = path.join(root, 'dsh');
fs.mkdirSync(dshHome, { mode: 0o700 });
const patch = path.join(dshHome, 'route.patch.yml');
fs.writeFileSync(
  patch,
  `- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        apiKeyEnv: DIS_DATALAYER_MODEL_ACCESS\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(path.join(dshHome, 'sessions'))}\n    compression: none\n- id: session-telemetry-otel\n  disabled: true\n`,
  { mode: 0o600 }
);
const modelEnv = {
  ...process.env,
  DEEPSEEK_API_KEY: undefined,
  DIS_DATALAYER_MODEL_ACCESS: access,
};
for (const name of Object.keys(modelEnv)) {
  if (/JUPYTER/i.test(name)) {
    modelEnv[name] = undefined;
  }
}
connections.redactEnvironment(modelEnv);
const provider = new DeepSeekHarnessProvider({
  binary: values.binary,
  dshHome,
  provider: 'openai-codex',
  args: ['--profile', 'sdk', '--patch', patch],
  requestTimeoutMs: 60000,
  env: modelEnv,
});
const tools = session.tools
  .filter((tool) => tool.name === 'notebook_observe_image')
  .map((tool) => ({
    ...tool,
    execute: async (input, context) => {
      const result = await tool.execute(input, context);
      report.calls.push({
        name: tool.name,
        input,
        metadata: result.data ?? result,
        imageHashes: result.images?.map((image) =>
          createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')
        ),
      });
      for (const image of result.images ?? []) {
        fs.writeFileSync(path.join(root, 'observed-plot.png'), Buffer.from(image.data, 'base64'), {
          mode: 0o600,
        });
      }
      persist();
      return result;
    },
  }));
let query;
let timer;
try {
  async function* input() {
    yield {
      role: 'user',
      content: `Observe this plot using notebook_observe_image with exactly ${JSON.stringify(target)}. Describe the visible chart type, number of marked points, x-axis label, y-axis label and direction. Return one JSON object with keys chartType, pointCount, xAxis, yAxis, trend. Use only the image observation tool; do not read files, source code or data, execute code, invoke shell or browse.`,
    };
  }
  query = provider.queryStream(input(), {
    cwd: values.project,
    sessionKey: 'datalayer-image-observation',
    settingSources: [],
    tools,
    model: values.model,
    reasoningEffort: 'low',
    systemPrompt:
      'This is a read-only visual observation. Use only notebook_observe_image. Interpret the returned native image; do not infer its appearance from code or data.',
  });
  timer = setTimeout(() => query.handle.cancel(), 120000);
  for await (const event of query.iterator) {
    report.events.push({
      type: event.type,
      ...(event.type === 'text' ? { content: event.content } : {}),
    });
  }
  report.sessionId = query.handle.sessionId;
  const text = report.events
    .filter((e) => e.type === 'text')
    .map((e) => e.content)
    .join('');
  report.answer = text;
  report.visualAnswerMatches =
    /(line|折线)/i.test(text) &&
    /3/.test(text) &&
    /step/i.test(text) &&
    /value/i.test(text) &&
    /(increas|upward|上升|递增)/i.test(text);
} catch (error) {
  report.error = secrets.reduce(
    (text, secret) => text.replaceAll(secret, '[REDACTED]'),
    error.message
  );
} finally {
  clearTimeout(timer);
  query?.handle.close();
  session.dispose();
  await provider.shutdown();
  const native = [];
  const scan = (directory) => {
    if (!fs.existsSync(directory)) {
      return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(file);
      } else if (file.endsWith('.jsonl')) {
        const raw = fs.readFileSync(file, 'utf8');
        if (secrets.some((secret) => raw.includes(secret))) {
          throw new Error('Credential reached native history');
        }
        native.push(
          ...raw
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        );
      }
    }
  };
  scan(path.join(dshHome, 'sessions'));
  let images = 0;
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (value.type === 'image' && value.attachment?.attachmentId) {
      images++;
    }
    for (const item of Object.values(value)) {
      visit(item);
    }
  };
  native.forEach(visit);
  report.nativeImageReferences = images;
  report.nativeRoutes = native
    .map((item) => item.event ?? item)
    .filter((item) => item.type === 'request/header')
    .map((item) => item.data.header.config);
  report.completed =
    report.calls.length > 0 &&
    images > 0 &&
    report.visualAnswerMatches &&
    report.nativeRoutes.length > 0 &&
    report.nativeRoutes.every(
      (route) => route.model === values.model && route.provider === 'openai-codex'
    );
  report.credentialsAbsentFromNativeHistory = true;
  report.finishedAt = new Date().toISOString();
  persist();
  console.log(
    JSON.stringify({
      completed: report.completed,
      nativeImageReferences: images,
      visualAnswerMatches: report.visualAnswerMatches,
      toolCalls: report.calls.length,
      error: report.error,
    })
  );
  if (!report.completed) {
    process.exitCode = 1;
  }
}
