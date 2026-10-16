// Compare native SDK retry behavior with/without the provider using owned HTTP only.
// Build first: pnpm run build && node tests/integration/claude-sdk-owned-retries.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = await mkdtemp(join(tmpdir(), 'disclaude-sdk-retries-'));
const requests = { sdk: [], provider: [] };
let active;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* discard the owned prompt */ }
  if (request.method !== 'POST' || new URL(request.url, 'http://owned').pathname !== '/v1/messages') {
    response.writeHead(404).end();
    return;
  }
  const sequence = requests[active];
  sequence.push(Date.now());
  // Three retries exercise the framework default beyond the removed host cap.
  const retry = sequence.length <= 3;
  response.writeHead(retry ? 429 : 400, { 'content-type': 'application/json',
    ...(retry ? { 'retry-after': '3' } : {}), 'request-id': `owned-${active}-${sequence.length}` });
  response.end(JSON.stringify({ type: 'error', error: {
    type: retry ? 'rate_limit_error' : 'invalid_request_error',
    message: retry ? 'Owned retry fixture' : 'Owned terminal fixture; no inference',
  } }));
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
  ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  OWNED_RETRY_KEY: 'owned-fixture-key' });
process.env.DISCLAUDE_CONFIG_PATH = config;
// A preconfigured local SDK retry override would invalidate the default comparison.
assert.equal(process.env.CLAUDE_CODE_MAX_RETRIES, undefined);

try {
  const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
  const { query } = await import(require.resolve('@anthropic-ai/claude-agent-sdk'));
  const { ClaudeSDKProvider } = await import('../../packages/core/dist/sdk/providers/claude/provider.js');
  const { adaptOptions } = await import('../../packages/core/dist/sdk/providers/claude/options-adapter.js');
  const { adaptUserInput } = await import('../../packages/core/dist/sdk/providers/claude/message-adapter.js');
  const { privateSdkSettings } = await import('../../packages/core/dist/sdk/providers/claude/private-settings.js');
  const reports = {};
  for (active of ['sdk', 'provider']) {
    const directory = join(root, active);
    await mkdir(directory);
    const options = { settingSources: [], cwd: directory, model: 'fixture-model',
      env: { ANTHROPIC_API_KEY: 'owned-fixture-key', ANTHROPIC_BASE_URL: base,
        CLAUDE_CONFIG_DIR: join(directory, 'claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } };
    const input = async function* () { yield { role: 'user', content: 'Owned fixture, no tools or inference.' }; };
    let iterator, handle, cleanup = () => {};
    if (active === 'sdk') {
      const native = privateSdkSettings(adaptOptions(options));
      cleanup = native.cleanup;
      iterator = query({ prompt: (async function* () {
        for await (const message of input()) yield adaptUserInput(message);
      })(), options: native.options });
      handle = { interrupt: () => iterator.interrupt(), close: () => iterator.close() };
    } else {
      ({ iterator, handle } = new ClaudeSDKProvider().queryStream(input(), options));
    }
    let timedOut = false, failure;
    const events = [];
    const timer = setTimeout(() => { timedOut = true; handle.close(); }, 25_000);
    try {
      try { for await (const message of iterator) events.push(message); }
      catch (error) { failure = error; }
      assert.equal(timedOut, false, `${active} timed out`);
      assert.equal(requests[active].length, 4, `${active} should exhaust three owned 429s then stop on 400`);
      if (active === 'provider') {
        assert.ok(events.every(message => !('retryProgress' in (message.metadata ?? {}))
          && !('queryUsage' in (message.metadata ?? {}))));
        assert.ok(events.filter(message => message.metadata?.systemSubtype === 'api_retry')
          .every(message => message.content === '' && message.type === 'text'));
      }
      const times = requests[active];
      const intervalsMs = times.slice(1).map((time, index) => time - times[index]);
      assert.ok(intervalsMs.every(ms => ms >= 2800 && ms < 4500), `${active} Retry-After intervals ${intervalsMs}`);
      reports[active] = { requests: times.length, intervalsMs,
        nativeRetryEvents: events.filter(message => message.subtype === 'api_retry'
          || message.metadata?.systemSubtype === 'api_retry').length,
        terminalError: failure ? failure.constructor.name : null };
    } finally {
      clearTimeout(timer);
      handle.close();
      await iterator.return?.().catch(() => {});
      cleanup();
    }
  }
  assert.equal(reports.sdk.requests, reports.provider.requests);
  assert.equal(reports.sdk.nativeRetryEvents, reports.provider.nativeRetryEvents);
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(reports.sdk.intervalsMs[index] - reports.provider.intervalsMs[index]) < 500);
  }
  console.log(JSON.stringify({ passed: true, sdkRetryPolicy: 'default, unchanged', reports,
    externalModelInputs: 0, channelConnections: 0 }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
