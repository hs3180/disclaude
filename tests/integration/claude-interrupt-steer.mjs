// Owned native SDK interrupt-and-replace regression; no external inference or channels.
// Build first, then: node tests/integration/claude-interrupt-steer.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'disclaude-provider-interrupt-'));
const config = join(root, 'config.json');
await writeFile(
  config,
  JSON.stringify({
    agents: { owned: { backend: 'claude', llm: 'owned' } },
    llms: {
      owned: { model: 'fixture-model', api: { protocol: 'anthropic', apiKey: '$OWNED_RETRY_KEY' } },
    },
    channels: {},
    workspace: { dir: root },
  }),
  { mode: 0o600 }
);
Object.assign(process.env, {
  LOG_TO_FILE: 'false',
  LOG_LEVEL: 'warn',
  NODE_ENV: 'production',
  OWNED_RETRY_KEY: 'owned-fixture-key',
});
process.env.DISCLAUDE_CONFIG_PATH = config;
const marker = join(root, 'tool-state.json');
const script = join(root, 'owned-tool.cjs');
await writeFile(
  script,
  `const fs = require('node:fs'); const marker = ${JSON.stringify(marker)};
fs.writeFileSync(marker, JSON.stringify({state:'running',pid:process.pid}));
process.on('SIGTERM', () => {fs.writeFileSync(marker, JSON.stringify({state:'interrupted',pid:process.pid}));process.exit(0);});
setTimeout(() => {fs.writeFileSync(marker, JSON.stringify({state:'completed',pid:process.pid}));console.log('OWNED_TOOL_COMPLETED');}, 30000);`
);
const start = Date.now();
const events = [],
  calls = [];
let toolIssued = false;
function emit(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function nativeReply(response, tool) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  emit(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_owned_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  if (tool) {
    emit(response, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'owned_bash_5258', name: 'Bash', input: {} },
    });
    emit(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
          description: 'Owned interrupt fixture waiting 30 seconds',
          timeout: 60000,
        }),
      },
    });
  } else {
    emit(response, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    emit(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OWNED_NEW_INPUT_COMPLETED' },
    });
  }
  emit(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  emit(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  emit(response, 'message_stop', { type: 'message_stop' });
  response.end();
}
const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(text);
  const first =
    !toolIssued &&
    body.tools?.some((tool) => tool.name === 'Bash') &&
    text.includes('OWNED_FIRST_5258');
  if (first) toolIssued = true;
  calls.push({
    atMs: Date.now() - start,
    tool: first,
    hasSecondInput: text.includes('OWNED_SECOND_5258'),
  });
  nativeReply(response, first);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const inputQueue = [];
let wake;
let end = false;
const input = async function* () {
  while (!end) {
    if (inputQueue.length) {
      yield inputQueue.shift();
    } else
      await new Promise((resolve) => {
        wake = resolve;
      });
  }
};
const submit = (content, uuid) => {
  inputQueue.push({
    role: 'user',
    content,
    correlation: { chatId: 'owned', traceId: `owned:${uuid}`, runId: uuid, sourceMessageId: uuid },
  });
  wake?.();
  wake = undefined;
};
let native,
  timeout,
  timedOut = false;
let cleanupNative = async () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test, label, ms = 12000) => {
  const begin = Date.now();
  while (!(await test())) {
    if (Date.now() - begin > ms) throw new Error(`Timed out waiting for ${label}`);
    await sleep(40);
  }
};
const toolState = async () => {
  try {
    return JSON.parse(await readFile(marker, 'utf8'));
  } catch {
    return undefined;
  }
};
try {
  await mkdir(join(root, 'claude'));
  const { ClaudeSDKProvider } =
    await import('../../packages/core/dist/sdk/providers/claude/provider.js');
  const { iterator, handle } = new ClaudeSDKProvider().queryStream(input(), {
    cwd: root,
    model: 'fixture-model',
    settingSources: [],
    permissionMode: 'bypassPermissions',
    env: {
      ANTHROPIC_API_KEY: 'owned-fixture-key',
      ANTHROPIC_BASE_URL: base,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
  cleanupNative = async () => {
    await handle.interrupt?.();
  };
  native = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: () => handle.steer('Owned replacement'),
    close: () => handle.close(),
  };
  timeout = setTimeout(() => {
    timedOut = true;
    native.close();
  }, 40000);
  let iteratorEnded = false,
    iteratorFailure;
  const drain = (async () => {
    try {
      for await (const message of native) {
        const event = message.raw ?? {};
        events.push({
          metadata: message.metadata,
          atMs: Date.now() - start,
          type: event.type,
          subtype: event.subtype,
          is_error: event.is_error,
          result: event.result,
          errors: event.errors,
          stop_reason: event.stop_reason,
          userPayload: event.type === 'user' ? event.message : undefined,
          lifecycle: event.type === 'command_lifecycle' ? event : undefined,
          text:
            event.type === 'assistant'
              ? event.message?.content
                  ?.filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('')
              : undefined,
          tool:
            event.type === 'assistant'
              ? event.message?.content?.find((block) => block.type === 'tool_use')?.name
              : undefined,
          user_message_uuid: event.user_message_uuid,
          user_message_uuids: event.user_message_uuids,
        });
      }
    } catch (error) {
      iteratorFailure = { name: error.name, message: error.message };
    } finally {
      iteratorEnded = true;
    }
  })();
  submit(
    'OWNED_FIRST_5258: run the owned Bash tool exactly once.',
    '11111111-1111-4111-8111-111111111111'
  );
  await until(async () => (await toolState())?.state === 'running', 'owned Bash started');
  const runningAt = Date.now() - start,
    before = events.length;
  const interruptAt = Date.now();
  const ack = await native.interrupt();
  const ackMs = Date.now() - interruptAt;
  await sleep(200);
  const afterInterruptEvents = events.slice(before);
  const iteratorAliveAfterAck = !iteratorEnded;
  submit(
    'OWNED_SECOND_5258: respond now with the owned success text.',
    '22222222-2222-4222-8222-222222222222'
  );
  await until(
    () => events.some((event) => event.text?.includes('OWNED_NEW_INPUT_COMPLETED')),
    'replacement input response'
  );
  await until(
    () => events.filter((event) => event.type === 'result').length >= 2,
    'both result terminals'
  );
  const finalToolState = await toolState();
  const report = {
    passed: !timedOut,
    runningAt,
    ackMs,
    ack: ack ?? null,
    iteratorAliveAfterAck,
    iteratorEnded,
    iteratorFailure,
    afterInterruptEvents,
    events,
    calls,
    finalToolState,
    externalModelInputs: 0,
    channelConnections: 0,
  };
  assert.equal(timedOut, false);
  assert.ok(iteratorAliveAfterAck);
  assert.ok(calls.some((call) => call.hasSecondInput));
  assert.notEqual(finalToolState?.state, 'completed');
  const terminals = events.filter((event) => event.type === 'result');
  assert.equal(terminals[0].metadata?.terminatedReason, 'interrupted');
  assert.equal(terminals[0].metadata?.interruptionMode, 'replace');
  assert.equal(terminals[0].metadata?.upstreamApiError, undefined);
  assert.equal(terminals[1].metadata?.terminatedReason, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    terminals.map((event) => event.user_message_uuid),
    ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  );
  console.log(JSON.stringify(report, null, 2));
  end = true;
  wake?.();
  native.close();
  await drain;
} finally {
  clearTimeout(timeout);
  end = true;
  wake?.();
  try {
    native?.close();
  } catch {}
  await cleanupNative().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
