import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import { TaskQuestionStore, type TaskQuestion } from '@disclaude/core';
import { FeishuTaskQuestionCards } from './task-question-cards.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(plain = false) {
  const root = await mkdtemp(join(tmpdir(), 'feishu-task-question-')); roots.push(root);
  const store = new TaskQuestionStore(join(root, 'questions'));
  const question: TaskQuestion = { id: randomUUID(), taskKey: 'task-A', question: 'Which public dataset?', chatId: 'chat-A', actorId: 'user-A',
    sourceMessageId: 'source-A', projectRoot: '/project/A', ...(plain ? { replyRootId: null } : { threadRootId: 'topic-A', replyRootId: 'topic-A' }) };
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'actual-card', chat_id: 'chat-A' } });
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'actual-card', chat_id: 'chat-A' } });
  const patch = vi.fn().mockResolvedValue({ code: 0 }), get = vi.fn();
  const client = { im: { message: { reply, create, patch, get } } } as unknown as Client;
  const authorize = vi.fn(), wake = vi.fn().mockResolvedValue('actual-admission'), admitted = vi.fn().mockResolvedValue('actual-admission');
  const host = { store, authorize, wake, admitted }, cards = new FeishuTaskQuestionCards(client, 'fixture-app', host);
  const callback = (answer = 'Public feedback value') => ({ event_id: 'actual-event', operator: { open_id: 'user-A' },
    context: { open_chat_id: 'chat-A', open_message_id: 'actual-card' }, action: { tag: 'button', name: `task-question:${question.id}:submit`,
      form_value: { [`task-question:${question.id}:answer`]: answer } } });
  const message = () => ({ message_id: 'actual-card', chat_id: 'chat-A', msg_type: 'interactive', parent_id: 'topic-A', root_id: 'topic-A',
    sender: { id: 'fixture-app', id_type: 'app_id', sender_type: 'app' }, body: { content: (plain ? create : reply).mock.calls[0][0].data.content } });
  return { root, store, question, reply, create, patch, get, client, host, cards, authorize, wake, admitted, callback, message };
}

it.each([false, true])('sends one actual-route SDK request and only explicit submission records/wakes (plain=%s)', async plain => {
  const f = await fixture(plain); await f.cards.ask(f.question);
  const send = plain ? f.create : f.reply;
  const [[request]] = send.mock.calls;
  expect(request.data.uuid).toBe(f.question.id);
  if (plain) { expect(request.data.receive_id).toBe('chat-A'); expect(f.reply).not.toHaveBeenCalled(); }
  else { expect(request.path.message_id).toBe('topic-A'); expect(request.data.reply_in_thread).toBe(true); expect(f.create).not.toHaveBeenCalled(); }
  const typing = { action: { tag: 'input', name: `task-question:${f.question.id}:answer`, get form_value() { throw new Error('Typing values must not be read'); } } };
  expect(FeishuTaskQuestionCards.isCallback(typing)).toBe(true);
  expect(f.cards.handleAuthenticatedCallback(typing).toast.content).toContain('提交'); expect(f.patch).not.toHaveBeenCalled();
  f.cards.handleAuthenticatedCallback(f.callback());
  await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('delivered'));
  f.cards.handleAuthenticatedCallback(f.callback()); await f.cards.close();
  expect(f.wake).toHaveBeenCalledOnce(); expect(f.get).not.toHaveBeenCalled();
  const contents = f.patch.mock.calls.map(([value]) => value.data.content);
  expect(contents.at(-1)).toContain('已保存并送回原任务'); expect(contents.join('')).not.toContain('Public feedback value');
  expect(contents.join('')).not.toContain('过期'); expect(send).toHaveBeenCalledOnce();
});

it('reconciles an unknown send by checking the real SDK card, app and original route before saving an early answer', async () => {
  const f = await fixture(); f.reply.mockRejectedValueOnce(new Error('private transport details'));
  await expect(f.cards.ask(f.question)).rejects.toThrow('not confirmed');
  f.get.mockResolvedValueOnce({ code: 0, data: { items: [f.message()] } });
  f.cards.handleAuthenticatedCallback(f.callback());
  await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('delivered'));
  await f.cards.close(); expect(f.reply).toHaveBeenCalledOnce(); expect(f.get).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'actual-card' } });
});

it.each(['app', 'route', 'token', 'deleted'])('refuses a card readback with the wrong %s', async wrong => {
  const f = await fixture(); f.reply.mockRejectedValueOnce(new Error('lost ACK')); await expect(f.cards.ask(f.question)).rejects.toThrow();
  const message = f.message();
  if (wrong === 'app') { message.sender.id = 'other-app'; }
  if (wrong === 'route') { message.parent_id = 'other-topic'; message.root_id = 'other-topic'; }
  if (wrong === 'token') { message.body.content = '{}'; }
  f.get.mockResolvedValueOnce({ code: 0, data: { items: [{ ...message, deleted: wrong === 'deleted' }] } });
  f.cards.handleAuthenticatedCallback(f.callback()); await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce()); await f.cards.close();
  expect((await f.store.get(f.question.id))?.answer).toBeUndefined(); expect(f.wake).not.toHaveBeenCalled();
});

it('persists an answer despite failed repaint and keeps unknown parent admission ready for reconciliation', async () => {
  const f = await fixture(); await f.cards.ask(f.question); f.patch.mockRejectedValueOnce(new Error('private repaint failure'));
  f.wake.mockRejectedValueOnce(new Error('unknown actual admission ACK'));
  f.cards.handleAuthenticatedCallback(f.callback());
  await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('uncertain'));
  expect((await f.store.get(f.question.id))?.answer?.text).toBe('Public feedback value');
  await f.cards.reconcileWake(f.question.id); expect(f.wake).toHaveBeenCalledOnce(); await f.cards.close();
});

it('accepts the existing persisted card after adapter reconstruction without sending another card', async () => {
  const f = await fixture(); await f.cards.ask(f.question); await f.cards.close();
  const restored = new FeishuTaskQuestionCards(f.client, 'fixture-app', f.host);
  restored.handleAuthenticatedCallback(f.callback()); await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('delivered'));
  await restored.close(); expect(f.reply).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledOnce();
});

it('does not route another actor, changed card or cancelled question into native work', async () => {
  const f = await fixture(); await f.cards.ask(f.question);
  const foreign = f.callback(); foreign.operator.open_id = 'other-user'; f.cards.handleAuthenticatedCallback(foreign);
  const wrongCard = f.callback(); wrongCard.context.open_message_id = 'other-card'; f.cards.handleAuthenticatedCallback(wrongCard);
  await f.store.cancel(f.question.id); f.cards.handleAuthenticatedCallback(f.callback()); await f.cards.close();
  expect(f.wake).not.toHaveBeenCalled(); expect((await f.store.get(f.question.id))?.answer).toBeUndefined();
});

it('joins an owned repaint on shutdown, preserves the answer and wakes only after a restored host accepts it', async () => {
  const f = await fixture(); await f.cards.ask(f.question);
  let release!: () => void;
  f.patch.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ code: 0 }); }));
  f.cards.handleAuthenticatedCallback(f.callback()); await vi.waitFor(() => expect(f.patch).toHaveBeenCalledOnce());
  let closed = false; const closing = f.cards.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); await expect(f.cards.ask(f.question)).rejects.toThrow('closing');
  release(); await closing;
  expect((await f.store.get(f.question.id))?.answer?.text).toBe('Public feedback value'); expect(f.wake).not.toHaveBeenCalled();
  const restored = new FeishuTaskQuestionCards(f.client, 'fixture-app', f.host);
  restored.handleAuthenticatedCallback(f.callback()); await vi.waitFor(async () => expect((await f.store.get(f.question.id))?.wake).toBe('delivered'));
  await restored.close(); expect(f.wake).toHaveBeenCalledOnce();
});
