// Real SDK retry admission against owned 429 + Retry-After: 60, no inference.
// Build first, then: node tests/integration/claude-retry-budget.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'disclaude-retry-budget-'));
const requests = [];
let firstPost;
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  if (request.method === 'POST') firstPost ??= Date.now();
  request.resume();
  response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Owned 60-second retry fixture' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const config = join(root, 'config.json');
await writeFile(config, JSON.stringify({
  agents: { owned: { backend: 'claude', llm: 'owned' } },
  llms: { owned: { model: 'fixture-model', api: { protocol: 'anthropic', baseUrl: base, apiKey: '$OWNED_RETRY_KEY' } } },
  channels: {}, workspace: { dir: root }, logging: { level: 'info', pretty: false },
}), { mode: 0o600 });
Object.assign(process.env, { LOG_TO_FILE: 'false', LOG_LEVEL: 'info', NODE_ENV: 'production',
  DISCLAUDE_CONFIG_PATH: config, CLAUDE_CONFIG_DIR: join(root, 'claude'),
  ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OWNED_RETRY_KEY: 'owned-fixture-key' });
let stream;
let timer;
let timedOut = false;
try {
  const { ClaudeSDKProvider } = await import('../../packages/core/dist/sdk/providers/claude/provider.js');
  const { automaticReplayBlock } = await import('../../packages/core/dist/utils/replay-safety.js');
  const provider = new ClaudeSDKProvider();
  stream = provider.queryStream((async function* () { yield { role: 'user', content: 'Owned retry admission fixture. Do not use tools.' }; })(), {
    settingSources: [], cwd: root, model: 'fixture-model',
    env: { ANTHROPIC_API_KEY: 'owned-fixture-key', ANTHROPIC_BASE_URL: base,
      CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_CODE_MAX_RETRIES: '2',
      DISCLAUDE_RETRY_BACKOFF_BUDGET_MS: '5000' },
  });
  timer = setTimeout(() => { timedOut = true; stream.handle.cancel(); }, 12_000);
  let failure;
  const progress = [];
  try { for await (const message of stream.iterator) {
    if (message.metadata?.retryProgress) progress.push(message.metadata.retryProgress);
  } } catch (error) { failure = error; }
  await stream.handle.interrupt();
  assert.equal(timedOut, false);
  assert.ok(failure instanceof Error);
  assert.equal(automaticReplayBlock(failure), 'retry-budget-exhausted');
  assert.match(failure.message, /requested 60000ms wait exceeds remaining 5000ms/);
  const elapsedAfterFirstPostMs = Date.now() - firstPost;
  assert.ok(elapsedAfterFirstPostMs < 5000, `fixture took ${elapsedAfterFirstPostMs}ms after first API request`);
  // Auxiliary title generation may issue a second POST; this is not a retry
  // or billing counter. Both share this owned endpoint and no inference runs.
  const posts = requests.filter(request => request.method === 'POST');
  assert.ok(posts.length >= 1 && posts.length <= 2);
  console.log(JSON.stringify({ nativeRetryBudgetFixture: { passed: true, requests, progress,
    elapsedAfterFirstPostMs, policy: { sdkMaxRetries: 2, backoffBudgetMs: 5000 },
    replayBlock: automaticReplayBlock(failure), error: failure.message, externalModelInputs: 0, channelConnections: 0 } }));
} finally {
  clearTimeout(timer);
  try { await stream?.handle.interrupt?.(); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
