// Real installed SDK against an owned rejection endpoint; no external inference.
// Run after `pnpm run build`: node tests/integration/claude-attempt-exit.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'disclaude-attempt-exit-'));
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  request.resume();
  response.writeHead(429, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Owned rejection fixture' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const config = join(root, 'config.json');
await writeFile(config, JSON.stringify({
  agents: { owned: { backend: 'claude', llm: 'owned' } },
  llms: { owned: { model: 'fixture-model', api: { protocol: 'anthropic', baseUrl: base, apiKey: '$OWNED_ATTEMPT_KEY' } } },
  channels: {}, workspace: { dir: root }, logging: { level: 'info', pretty: false },
}), { mode: 0o600 });
Object.assign(process.env, { LOG_TO_FILE: 'false', LOG_LEVEL: 'info', NODE_ENV: 'production',
  CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_CODE_MAX_RETRIES: '0',
  ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OWNED_ATTEMPT_KEY: 'owned-fixture-key' });
process.env.DISCLAUDE_CONFIG_PATH = config;
let stream;
let timer;
let timedOut = false;
try {
  const { ClaudeSDKProvider } = await import('../../packages/core/dist/sdk/providers/claude/provider.js');
  const { automaticReplayBlock } = await import('../../packages/core/dist/utils/replay-safety.js');
  const provider = new ClaudeSDKProvider();
  stream = provider.queryStream((async function* () { yield { role: 'user', content: 'Owned rejection fixture; do not use tools.' }; })(), {
    settingSources: [], cwd: root, model: 'fixture-model',
    env: { ANTHROPIC_API_KEY: 'owned-fixture-key', ANTHROPIC_BASE_URL: base,
      CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_TIMEOUT: '5000' },
  });
  timer = setTimeout(() => { timedOut = true; stream.handle.cancel(); }, 20_000);
  let failure;
  const terminals = [];
  try {
    for await (const message of stream.iterator) {
      if (message.type === 'result') terminals.push(message.metadata);
    }
  } catch (error) { failure = error; }
  assert.equal(timedOut, false);
  assert.ok(failure instanceof Error);
  assert.ok(automaticReplayBlock(failure));
  assert.equal(terminals.length, 1);
  assert.ok(terminals[0].automaticReplayBlocked);
  assert.ok(requests.some(request => new URL(request.path, base).pathname === '/v1/messages'));
  await stream.handle.interrupt(); // Rejects if the owned native exit is unconfirmed.
  console.log(JSON.stringify({ nativeAttemptFixture: { passed: true, replayBlock: automaticReplayBlock(failure),
    requests, terminals, externalModelInputs: 0, channelConnections: 0 } }));
} finally {
  clearTimeout(timer);
  try { await stream?.handle.interrupt?.(); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
