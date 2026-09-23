import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { AgentMessage, UserInput } from '../../packages/core/src/sdk/types.js';
import { CodexAgentProvider } from '../../packages/core/src/sdk/providers/codex/provider.js';
import { FeishuAgentInput } from '../../packages/service/src/channels/feishu/agent-input.js';

// Real Codex model/app-server and product card adapter. Feishu HTTP delivery and
// the human submission are captured/simulated; live-channel acceptance is separate.
// Luna currently exposes the RPC tool. Async is a separate capability probe,
// explicitly enabled only when checking that optional model/tool combination.
// Codex 0.155 can represent the async tool as either the older
// `item/completed`/agentMessage.questions notification or a non-blocking
// item/tool/requestUserInput RPC. The latter still answers through the
// original JSON-RPC request and must not be mislabeled as a steer-based
// notification.
const questionTools = process.env.DISCLAUDE_E2E_CODEX_ASYNC_INPUT === '1'
  ? ['request_user_input', 'request_user_input_async'] as const
  : ['request_user_input'] as const;
it.skipIf(process.env.DISCLAUDE_E2E_CODEX_INPUT !== '1').each(questionTools)('answers a real Codex %s question through its native card and completes the original turn', async tool => {
  const asyncTool = tool === 'request_user_input_async';
  const root = await mkdtemp(join(tmpdir(), 'codex-input-e2e-'));
  const provider = new CodexAgentProvider({
    transport: 'app-server',
    builtinsDir: root,
    env: { ...process.env },
  });
  let card: { body: { elements: Array<{ tag: string; elements?: Array<{ name: string }> }> } } | undefined;
  let requests = 0;
  let answers = 0;
  let sawAsyncNotification = false;
  const questionItems = new Set<string>();
  const client = { im: { message: {
    reply: (data: { data: { content: string } }) => {
      card = JSON.parse(data.data.content);
      return Promise.resolve({ code: 0, data: { message_id: 'test-card', chat_id: 'test-chat' } });
    }, patch: () => Promise.resolve({ code: 0 }),
  } } } as unknown as Client;
  const ui = new FeishuAgentInput(client);
  const inputContext = { actorId: 'test-actor', chatId: 'test-chat', sourceMessageId: 'test-source' };
  const stream = provider.queryStream((async function* (): AsyncGenerator<UserInput> {
    const instruction = asyncTool
      // Codex 0.155 exposes this capability to the model as request_user_input
      // while the app-server marks the resulting request non-blocking. Keep
      // the acceptance prompt semantic so it does not depend on a removed
      // request_user_input_async tool name in the model's tool namespace.
      ? 'Use the non-blocking user-input capability (the app-server request must have isBlocking=false)'
      : 'Call the actual request_user_input tool';
    yield { role: 'user', inputContext, content: `Interaction integration test: ${instruction} to ask exactly one question, which browser should this test use? Offer Chromium and Chrome with short descriptions. After receiving the answer, state the selected browser and finish. Do not use shell, files, network, other tools, subagents, or send messages. Do not ask through plain text.` };
  })(), { sessionKey: 'codex-input-e2e', cwd: root, model: 'gpt-5.6-luna', settingSources: [], onUserInput: async (request, context) => {
    requests++;
    questionItems.add(request.itemId);
    if (asyncTool) {
      expect(request.isBlocking).toBe(false);
      const kind = request.kind ?? 'rpc';
      expect(['rpc', 'async-message']).toContain(kind);
      sawAsyncNotification ||= kind === 'async-message';
    } else {
      expect(request.kind ?? 'rpc').toBe('rpc');
    }
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0].isSecret).toBe(false);
    expect(context).toEqual(inputContext);
    const choice = request.questions[0].options?.findIndex(option => /chromium/i.test(option.label)) ?? -1;
    expect(choice).toBeGreaterThanOrEqual(0);
    await ui.request(request, inputContext);
    const name = card?.body.elements.find(element => element.tag === 'form')?.elements?.at(-1)?.name;
    expect(name).toMatch(/^agent-input:/u);
    await ui.submit({ operator: { open_id: inputContext.actorId }, context: { open_message_id: 'test-card', open_chat_id: 'test-chat' },
      action: { name, form_value: { choice_0: String(choice) } } });
    answers++;
  } });
  const timer = setTimeout(() => stream.handle.close(), 150_000);
  const events: AgentMessage[] = [];
  try {
    for await (const event of stream.iterator) { events.push(event); }
    expect(requests).toBe(1);
    expect(answers).toBe(1);
    expect(events.some(event => event.type === 'error')).toBe(false);
    if (sawAsyncNotification) {
      expect(events.some(event => event.type === 'text' && questionItems.has(event.metadata?.messageId ?? ''))).toBe(false);
    }
    expect(events.some(event => event.type === 'text' && /chromium/i.test(event.content))).toBe(true);
    expect(events.some(event => event.type === 'result' && !event.metadata?.terminatedReason)).toBe(true);
  } finally { clearTimeout(timer); stream.handle.close(); provider.dispose(); ui.close(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
