import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';
import {
  createCLIProbe,
  probeSource,
  probeAuth,
  probeConnection,
  probeKernel,
} from './cli-probe-client.mjs';
import { DeepSeekHarnessProvider } from '../../packages/core/dist/sdk/providers/deepseek/provider.js';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    'oauth-auth-file': { type: 'string' },
    output: { type: 'string' },
    model: { type: 'string' },
    binary: { type: 'string', default: 'dsh' },
    'kernel-name': { type: 'string' },
  },
});
for (const field of ['oauth-auth-file', 'output', 'model']) {
  if (!values[field]) {
    throw new Error(`Explicit --${field} required`);
  }
}
if (values.model !== 'gpt-5.6-luna') {
  throw new Error('This explicit #5215/#5219 probe requires gpt-5.6-luna');
}
const root = path.resolve(values.output);
fs.mkdirSync(path.dirname(root), { recursive: true });
fs.mkdirSync(root, { mode: 0o700 });
const project = path.join(root, 'project');
fs.mkdirSync(project, { mode: 0o700 });
const auth = await probeAuth(values['env-file']);
const access = JSON.parse(fs.readFileSync(values['oauth-auth-file'], 'utf8')).tokens?.access_token;
const exp = access && JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp;
if (!access || !exp || exp * 1000 < Date.now() + 15 * 60_000) {
  throw new Error('Existing OAuth credential unavailable or near expiry');
}
const secrets = [access, auth.secret];
const sanitize = (text) =>
  secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text);
const client = new DatalayerJupyterClient({
  ...probeConnection(auth),
  allowInsecureHttp: true,
});
const originalKernels = await client.json('api/kernels');
const originalSessions = await client.json('api/sessions');
const notebook = `disclaude-datalayer-model-${randomUUID().slice(0, 8)}.ipynb`;
const report = {
  source: probeSource(),
  startedAt: new Date().toISOString(),
  scope:
    'Real DSH model + optional CLI-backed tools + configured Datalayer; not production Feishu/native UI acceptance',
  model: values.model,
  reasoningEffort: 'low',
  acceptanceOverride: '#5215/#5219 explicit model acceptance; daily model configuration unchanged',
  phases: [],
  calls: [],
  notebook,
  project,
};
const probe = await createCLIProbe({ envFile: values['env-file'], project, directory: project });
const notebookTools = await probe.modelTools();
const dshHome = path.join(root, 'dsh');
fs.mkdirSync(dshHome, { mode: 0o700 });
const route = path.join(dshHome, 'route.patch.yml');
fs.writeFileSync(
  route,
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
let peer;
const providers = [];
const stderr = [];
const persist = () =>
  fs.writeFileSync(
    path.join(root, 'report.json'),
    sanitize(JSON.stringify(report, null, 2)) + '\n',
    { mode: 0o600 }
  );
async function phase(name, prompt) {
  const provider = new DeepSeekHarnessProvider({
    binary: values.binary,
    dshHome,
    provider: 'openai-codex',
    args: ['--profile', 'sdk', '--patch', route],
    requestTimeoutMs: 60000,
    env: modelEnv,
  });
  providers.push(provider);
  const tools = notebookTools.map((tool) => ({
    ...tool,
    execute: async (input, invocation) => {
      const call = { tool: tool.name, input, startedAt: new Date().toISOString() };
      report.calls.push(call);
      call.output = await tool.execute(input, invocation);
      call.finishedAt = new Date().toISOString();
      persist();
      return call.output;
    },
  }));
  const nativeContext =
    '\nBound Project Notebooks: ' + JSON.stringify(await probe.call('notebook_list', {}));
  async function* messages() {
    yield { role: 'user', content: prompt + nativeContext };
  }
  const query = provider.queryStream(messages(), {
    cwd: project,
    sessionKey: 'real-datalayer-model-acceptance',
    settingSources: [],
    tools,
    model: values.model,
    reasoningEffort: 'low',
    systemPrompt:
      'Use the optional notebook tools for every Notebook read/edit/run/export; each tool invokes the public disclaude jupyter CLI in a separate Node process. The host is Node-only: do not run host Python, local Jupyter, shell commands or install dependencies. Use only the bound existing remote Notebook. Preserve human Markdown and source outside the explicit request. Query accepted run IDs until terminal, never replay unknown work. Report actual observations.',
    stderr: (chunk) => {
      if (stderr.join('').length < 24000) {
        stderr.push(chunk);
      }
    },
  });
  const result = { name, startedAt: new Date().toISOString(), events: [] };
  report.phases.push(result);
  const timer = setTimeout(() => query.handle.cancel(), 180000);
  try {
    for await (const event of query.iterator) {
      result.events.push({
        type: event.type,
        ...(event.type === 'text' ? { content: event.content } : {}),
      });
    }
    result.sessionId = query.handle.sessionId;
    result.finishedAt = new Date().toISOString();
    persist();
  } finally {
    clearTimeout(timer);
  }
  return result;
}
try {
  report.kernel = await probeKernel(client, values['kernel-name']);
  report.dshVersion = execFileSync(values.binary, ['--version'], { encoding: 'utf8' }).trim();
  if (report.dshVersion !== '0.1.2-rc.1') {
    throw new Error('Expected DSH 0.1.2-rc.1');
  }
  const absent = await client.response(`api/contents/${notebook}`);
  if (absent.status !== 404) {
    throw new Error('Scratch Notebook already exists');
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
      cells: [
        {
          id: 'model-heading',
          cell_type: 'markdown',
          metadata: {},
          source: '# Datalayer model MVP\nSynthetic data acceptance; no financial claims.',
        },
        {
          id: 'model-params',
          cell_type: 'code',
          metadata: {},
          source: 'mvp_value = 2',
          execution_count: null,
          outputs: [],
        },
        {
          id: 'model-analysis',
          cell_type: 'code',
          metadata: {},
          source: 'print("MODEL_RESULT", mvp_value * 3)',
          execution_count: null,
          outputs: [],
        },
        {
          id: 'model-human-note',
          cell_type: 'markdown',
          metadata: {},
          source: 'Human conclusion: keep my wording.',
        },
      ],
    },
  });
  const linked = await probe.command('link', undefined, ['--path', notebook]);
  if (values['kernel-name'])
    await client.json('api/sessions', 'POST', {
      path: notebook,
      name: notebook,
      type: 'notebook',
      kernel: { name: report.kernel.name },
    });
  await phase(
    'Initial model turn',
    'Read the bound live Notebook. Set only model-params to exactly `mvp_value = 23` using a fresh sourceHash. Execute model-params, then model-analysis, each with a distinct runId, and query until terminal. Report the printed MODEL_RESULT. Keep all Markdown unchanged.'
  );
  peer = await client.openDocument(notebook, linked.documentId);
  const first = peer.snapshot();
  report.firstResultVerified = JSON.stringify(
    first.cells.find((c) => c.id === 'model-analysis')?.outputs
  ).includes('MODEL_RESULT 69');
  report.firstKernelId = (await client.json('api/sessions')).find(
    (s) => s.path === notebook
  )?.kernel.id;
  peer.notebook.cells.find((c) => c.id === 'model-params').source = 'mvp_value = 31';
  const humanWording = 'Human conclusion: parameter changed to 31; preserve this exact wording.';
  peer.notebook.cells.find((c) => c.id === 'model-human-note').source = humanWording;
  await peer.flush();
  await phase(
    'Follow-up after independent live edit and fresh CLI processes',
    'A person changed the parameter and their Markdown in the same shared Notebook. Read the latest live cells. Execute the current model-params and model-analysis with new run IDs, query until terminal, and report the actual MODEL_RESULT. Preserve all human wording. Add one Markdown cell with ID model-agent-summary to record the observed result and that these are synthetic test data. Export one HTML/ipynb snapshot and include both links in your response.'
  );
  await peer.flush();
  const final = peer.snapshot();
  report.followupResultVerified = JSON.stringify(
    final.cells.find((c) => c.id === 'model-analysis')?.outputs
  ).includes('MODEL_RESULT 93');
  report.humanWordingPreserved =
    final.cells.find((c) => c.id === 'model-human-note')?.source === humanWording;
  report.parameterPreserved =
    final.cells.find((c) => c.id === 'model-params')?.source === 'mvp_value = 31';
  report.sameKernelId =
    report.firstKernelId ===
    (await client.json('api/sessions')).find((s) => s.path === notebook)?.kernel.id;
  report.export = report.calls.findLast((c) => c.tool === 'notebook_export')?.output;
  if (report.export) {
    const html = await client.json(`api/contents/${report.export.htmlPath}`);
    fs.writeFileSync(path.join(root, 'report.html'), html.content, { mode: 0o600 });
  }
  report.completed =
    report.firstResultVerified &&
    report.followupResultVerified &&
    report.humanWordingPreserved &&
    report.parameterPreserved &&
    report.sameKernelId &&
    !!report.export;
} catch (error) {
  report.completed = false;
  report.error = sanitize(error.message);
} finally {
  peer?.close();
  await probe.close();
  report.commands = probe.commands;
  report.providerCleanup = (await Promise.allSettled(providers.map((p) => p.shutdown()))).map(
    (r) => r.status
  );
  const sessions = await client.json('api/sessions');
  for (const owned of sessions.filter(
    (s) => s.path === notebook && !originalSessions.some((original) => original.id === s.id)
  )) {
    await client.json(`api/sessions/${owned.id}`, 'DELETE');
  }
  const kernels = await client.json('api/kernels');
  const afterSessions = await client.json('api/sessions');
  report.originalKernelsPreserved = originalKernels.every((k) =>
    kernels.some((after) => after.id === k.id)
  );
  report.originalSessionsPreserved = originalSessions.every((s) =>
    afterSessions.some((after) => after.id === s.id)
  );
  const events = [];
  const scan = (directory) => {
    if (!fs.existsSync(directory)) {
      return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(location);
      } else if (entry.isFile() && location.endsWith('.jsonl')) {
        const content = fs.readFileSync(location, 'utf8');
        if (secrets.some((secret) => content.includes(secret))) {
          throw new Error('Credential reached native history');
        }
        for (const line of content.split('\n').filter(Boolean)) {
          const item = JSON.parse(line);
          events.push(item.event ?? item);
        }
      }
    }
  };
  try {
    scan(path.join(dshHome, 'sessions'));
    report.nativeRouteEvidence = events
      .filter((e) => e.type === 'request/header')
      .map((e) => e.data.header.config);
    report.credentialsAbsentFromNativeHistory = true;
  } catch (error) {
    report.completed = false;
    report.historyInspectionError = error.message;
  }
  report.stderr = sanitize(stderr.join(''));
  report.finishedAt = new Date().toISOString();
  persist();
  console.log(
    JSON.stringify({
      output: root,
      completed: report.completed,
      model: report.model,
      firstResultVerified: report.firstResultVerified,
      followupResultVerified: report.followupResultVerified,
      humanWordingPreserved: report.humanWordingPreserved,
      sameKernelId: report.sameKernelId,
      toolCalls: report.calls.length,
      originalKernelsPreserved: report.originalKernelsPreserved,
      originalSessionsPreserved: report.originalSessionsPreserved,
      error: report.error,
    })
  );
  if (!report.completed || !report.originalKernelsPreserved || !report.originalSessionsPreserved) {
    process.exitCode = 1;
  }
}
