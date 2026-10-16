// Controlled native SDK rejection: no external inference or channel connection.
// Run after `pnpm run build`: node tests/integration/claude-structured-api-error.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owned = await mkdtemp(join(tmpdir(), 'disclaude-api-429-'));
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  request.resume();
  response.writeHead(429, { 'content-type': 'application/json', 'request-id': 'owned-structured-429' });
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Controlled fixture rejection' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const config = join(owned, 'config.json');
await writeFile(config, JSON.stringify({
  agents: { owned: { backend: 'claude', llm: 'owned' } },
  llms: { owned: { model: 'fixture-model', api: { protocol: 'anthropic', baseUrl: base, apiKey: '$OWNED_CLAUDE_API_KEY' } } },
  channels: {}, workspace: { dir: owned }, logging: { level: 'info', pretty: false },
}), { mode: 0o600 });
await mkdir(join(owned, 'claude'));
Object.assign(process.env, {
  LOG_TO_FILE: 'false', LOG_LEVEL: 'debug', NODE_ENV: 'production',
  CLAUDE_CONFIG_DIR: join(owned, 'claude'),
  CLAUDE_CODE_MAX_RETRIES: '0',
  ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  OWNED_CLAUDE_API_KEY: 'owned-fixture-key',
});
process.env.DISCLAUDE_CONFIG_PATH = config;
let stream;
let timeout;
let timedOut = false;
const terminals = [];
try {
  const { ClaudeSDKProvider } = await import('../../packages/core/dist/sdk/providers/claude/provider.js');
  const provider = new ClaudeSDKProvider();
  stream = provider.queryStream((async function* () { yield { role: 'user', content: 'Owned rejection fixture; do not use tools.' }; })(), {
    settingSources: [], cwd: owned, model: 'fixture-model', includePartialMessages: true,
    env: { ANTHROPIC_API_KEY: 'owned-fixture-key', ANTHROPIC_BASE_URL: base,
      CLAUDE_CONFIG_DIR: join(owned, 'claude'), CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_TIMEOUT: '5000' },
  });
  timeout = setTimeout(() => { timedOut = true; stream.handle.cancel(); }, 20_000);
  let thrown;
  try {
    for await (const message of stream.iterator) {
      if (message.type === 'result') terminals.push(message.metadata);
    }
  } catch (error) { thrown = error; }
  assert.equal(timedOut, false);
  assert.ok(requests.some(request => new URL(request.path, base).pathname === '/v1/messages' && request.method === 'POST'));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].upstreamApiError, true);
  assert.equal(terminals[0].upstreamApiErrorStatus, 429);
  assert.equal(terminals[0].upstreamApiErrorIsTransient, false);
  assert.ok(['stream', 'transcript'].includes(terminals[0].upstreamApiErrorSource));
  const { getErrorCategoryTag } = await import('../../packages/core/dist/utils/error-handler.js');
  if (thrown) assert.deepEqual(getErrorCategoryTag(thrown), { category: 'API', transient: false, status: 429, source: 'structured' });
  console.log(JSON.stringify({ passed: true, requests, terminals, thrownClassification: thrown ? getErrorCategoryTag(thrown) : null, externalModelInputs: 0, channelConnections: 0 }));
} finally {
  clearTimeout(timeout);
  stream?.handle.close();
  await stream?.iterator.return().catch(() => {});
  const transcriptShapes = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row.type === 'assistant') transcriptShapes.push({ keys: Object.keys(row),
            sessionId: row.sessionId, isApiErrorMessage: row.isApiErrorMessage,
            apiErrorStatus: row.apiErrorStatus, apiErrorIsTransient: row.apiErrorIsTransient,
            messageKeys: Object.keys(row.message ?? {}) });
        }
      }
    }
  }
  await inspect(join(owned, 'claude'));
  console.log(JSON.stringify({ fixtureDiagnostics: { requests, terminals, transcriptShapes } }));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(owned, { recursive: true, force: true });
}
