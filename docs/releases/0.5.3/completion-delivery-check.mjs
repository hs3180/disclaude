// Installed-code integration with a scripted SDK boundary and local Feishu API sinks.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
assert(process.argv[2], 'Pass the installed prebuilt package directory');
const installed = resolve(process.argv[2]);
const temp = mkdtempSync(join(tmpdir(), 'disclaude-completion-'));
process.chdir(temp);
process.env.DISCLAUDE_CONFIG_PATH = join(temp, 'config.json');
writeFileSync(
  process.env.DISCLAUDE_CONFIG_PATH,
  JSON.stringify({
    agent: { agentBackend: 'claude' },
    workspace: { dir: temp },
    logging: { level: 'silent' },
  })
);
const load = (file) => import(pathToFileURL(join(installed, 'packages/service/dist', file)).href);
const { ChatAgent } = await load('agents/chat-agent.js');
const { FeishuChannel } = await load('channels/feishu-channel.js');
const { createChannelCallbacksFactory } = await load('utils/channel-handlers.js');
const logger = Object.fromEntries(
  ['info', 'warn', 'error', 'debug', 'trace'].map((key) => [key, () => {}])
);
try {
  for (const scenario of [
    { type: 'p2p' },
    { type: 'group' },
    { type: 'topic' },
    { type: 'p2p', stream: true },
    { type: 'p2p', stream: true, fallback: true },
    { type: 'group', failed: true },
    { type: 'p2p', stream: true, cancel: true },
  ]) {
    const sent = [];
    const reactions = [];
    const events = [];
    const channel = new FeishuChannel({
      appId: 'lab',
      appSecret: 'synthetic',
      streamingCard: !!scenario.stream,
    });
    channel.setStatus('running'); // Skip external WebSocket startup; use local API sinks only.
    const send = async (request) => {
      const id = `om-output-${sent.length + 1}`;
      sent.push({ id, request });
      return { code: 0, data: { message_id: id } };
    };
    channel.client = {
      im: {
        message: { create: send, reply: send },
        messageReaction: {
          create: async (request) => {
            events.push('reaction');
            reactions.push(request);
            return { code: 0 };
          },
        },
      },
    };
    channel.streamingCardKitClient = {
      createCard: async () => ({ cardId: 'card-handle' }),
      updateElementContent: async () => {},
      finalizeStreaming: async () => {
        events.push('frozen');
        if (scenario.fallback) throw new Error('synthetic freeze failure');
        if (scenario.cancel) agent.abortController.abort();
      },
    };
    const callbacks = createChannelCallbacksFactory(channel, logger)('oc_lab');
    let done = false;
    callbacks.onDone = async () => {
      events.push('done');
      done = true;
    };
    const agent = new ChatAgent({
      chatId: 'oc_lab',
      callbacks,
      apiKey: 'synthetic',
      model: 'lab',
      provider: 'anthropic',
      workspaceDir: temp,
    });
    agent.onceMode = true;
    agent.isAgentTeamsEnabled = () => false;
    agent.createQueryStream = () => ({
      handle: { close() {}, cancel() {} },
      iterator: (async function* () {
        yield { parsed: { type: 'text', content: 'delivered answer' }, raw: {} };
        yield {
          parsed: {
            type: 'result',
            content: '✅ Complete',
            ...(scenario.failed ? { terminatedReason: 'turn_failed' } : {}),
          },
          raw: {},
        };
      })(),
    });
    try {
      await agent.processMessage({
        chatId: 'oc_lab',
        messageId: 'om-request',
        threadRootId: 'om-parent',
        chatType: scenario.type,
        payload: 'test',
      });
      const deadline = Date.now() + 5000;
      while (!done && Date.now() < deadline) await delay(10);
      assert(done, 'turn did not finish');
      assert(!sent.some(({ request }) => request.data.content.includes('✅ Complete')));
      if (scenario.failed || scenario.cancel) assert.equal(reactions.length, 0);
      else {
        assert.equal(reactions.length, 1);
        assert.equal(reactions[0].path.message_id, sent.at(-1).id);
        assert.equal(reactions[0].data.reaction_type.emoji_type, 'DONE');
        assert.equal(sent.at(-1).request.path.message_id, 'om-parent');
        assert(events.indexOf('reaction') < events.indexOf('done'));
        if (scenario.stream) assert(events.indexOf('frozen') < events.indexOf('reaction'));
      }
      assert.equal(channel.streamingSequences.size, 0);
      assert.equal(channel.streamingMessageIds.size, 0);
      console.log('INSTALLED_COMPLETION_OK', JSON.stringify(scenario));
    } finally {
      await agent.shutdown();
    }
  }
  console.log('INSTALLED_COMPLETION_MATRIX_OK');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
