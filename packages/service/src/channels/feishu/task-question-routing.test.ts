import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventDispatcher, type Client } from '@larksuiteoapi/node-sdk';
import { TaskQuestionStore, type TaskQuestion, type FeishuCardActionEventData } from '@disclaude/core';
import { MessageHandler } from './message-handler.js';

const logs = vi.hoisted(() => ({ logCardInteraction: vi.fn(), logIncomingMessage: vi.fn() }));
vi.mock('../../utils/message-logger.js', () => ({ messageLogger: logs }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(configured = true) {
  const root = await mkdtemp(join(tmpdir(), 'task-question-routing-')); roots.push(root);
  const store = new TaskQuestionStore(join(root, 'questions')), emitMessage = vi.fn(), emitControl = vi.fn(), sendMessage = vi.fn(), genericCard = vi.fn();
  const handler = new MessageHandler({ triggerModeManager: {} as never, mentionDetector: {} as never,
    interactionManager: { handleAction: genericCard } as never, callbacks: { emitMessage, emitControl, sendMessage },
    isRunning: () => true, hasControlHandler: () => false, tenantAccessToken: '' });
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'question-card', chat_id: 'chat-A' } }), patch = vi.fn().mockResolvedValue({ code: 0 });
  const client = { im: { message: { reply, patch } } } as unknown as Client;
  const wake = vi.fn().mockResolvedValue('actual-parent-admission'), authorize = vi.fn();
  if (configured) { handler.configureTaskQuestions('fixture-app', { store, wake, authorize, admitted: () => Promise.resolve('actual-parent-admission') }); }
  handler.initialize(client);
  const question: TaskQuestion = { id: randomUUID(), taskKey: 'task-A', question: 'Public feedback?', chatId: 'chat-A', actorId: 'user-A',
    sourceMessageId: 'source-A', projectRoot: '/project/A', threadRootId: 'topic-A', replyRootId: 'topic-A' };
  const callback = () => ({ operator: { open_id: 'user-A' }, context: { open_chat_id: 'chat-A', open_message_id: 'question-card' },
    action: { tag: 'button', name: `task-question:${question.id}:submit`, form_value: { [`task-question:${question.id}:answer`]: 'Saved public feedback' } } }) as unknown as FeishuCardActionEventData;
  return { handler, store, client, question, callback, emitMessage, emitControl, sendMessage, genericCard, reply, patch, wake };
}

it('routes authenticated task-card input directly to its host without generic agent/log replay', async () => {
  const f = await fixture(); await f.handler.requestTaskQuestion(f.question);
  const input = f.callback() as unknown as Record<string, unknown>; (input.action as Record<string, unknown>).tag = 'input';
  expect((await f.handler.handleCardAction(input as unknown as FeishuCardActionEventData))?.toast.content).toContain('提交');
  const dispatcher = new EventDispatcher({}).register({
    'card.action.trigger': (data: unknown) => f.handler.handleCardAction(data as FeishuCardActionEventData),
  } as Parameters<EventDispatcher['register']>[0]);
  await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'fixture-task-answer' }, event: f.callback() }, { needCheck: false });
  await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('delivered'));
  expect(f.emitMessage).not.toHaveBeenCalled(); expect(f.emitControl).not.toHaveBeenCalled(); expect(f.genericCard).not.toHaveBeenCalled();
  expect(logs.logCardInteraction).not.toHaveBeenCalled(); expect(logs.logIncomingMessage).not.toHaveBeenCalled();
  await f.handler.drainTaskQuestions(); f.handler.clearClient();
});

it('reserves task callback names even when the runtime is unavailable instead of turning them into user input', async () => {
  const f = await fixture(false);
  expect((await f.handler.handleCardAction(f.callback()))?.toast.content).toContain('暂不可用');
  await expect(f.handler.requestTaskQuestion(f.question)).rejects.toThrow('unavailable');
  expect(f.emitMessage).not.toHaveBeenCalled(); expect(f.genericCard).not.toHaveBeenCalled(); f.handler.clearClient();
});

it('requires draining before client replacement/clear and reconstructs old card routing without resending', async () => {
  const f = await fixture(); await f.handler.requestTaskQuestion(f.question);
  expect(() => f.handler.clearClient()).toThrow('Drain'); expect(() => f.handler.initialize(f.client)).toThrow('Drain');
  await f.handler.drainTaskQuestions(); f.handler.clearClient(); f.handler.initialize(f.client);
  await f.handler.handleCardAction(f.callback());
  await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('delivered'));
  expect(f.reply).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledOnce(); await f.handler.drainTaskQuestions(); f.handler.clearClient();
});
