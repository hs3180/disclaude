import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskQuestionStore, type TaskQuestion } from './task-question-store.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'task-question-')); roots.push(root);
  const store = new TaskQuestionStore(join(root, 'questions'));
  const question: TaskQuestion = { id: randomUUID(), taskKey: 'project/task-A', question: 'Which dataset should this task use?',
    chatId: 'chat-A', actorId: 'user-A', sourceMessageId: 'source-A', projectRoot: '/project/A', threadRootId: 'topic-A', replyRootId: 'topic-A' };
  const receipt = { messageId: 'actual-card-A', chatId: question.chatId, threadRootId: question.threadRootId, replyRootId: question.replyRootId };
  const answer = { actorId: question.actorId, chatId: question.chatId, messageId: receipt.messageId, text: 'Use the verified dataset', eventId: 'actual-callback-event' };
  await store.create(question);
  const delivered = async () => { await store.begin(question.id, 'delivery'); return await store.confirmDelivery(question.id, receipt); };
  return { root, store, question, receipt, answer, delivered };
}

it('keeps delivery, answer and actual wake acknowledgement distinct across reconstruction', async () => {
  const f = await fixture(); expect((await f.store.get(f.question.id))?.delivery).toBe('prepared');
  expect((await f.store.begin(f.question.id, 'delivery')).dispatch).toBe(true);
  expect((await f.store.confirmDelivery(f.question.id, f.receipt)).answer).toBeUndefined();
  const answered = await f.store.answer(f.question.id, f.answer);
  expect(answered.wake).toBe('pending'); expect(answered.answer).toEqual({ messageId: f.receipt.messageId, text: f.answer.text, eventId: f.answer.eventId });
  expect((await f.store.begin(f.question.id, 'wake')).dispatch).toBe(true);
  const finished = await f.store.confirmWake(f.question.id, 'actual-parent-admission'); expect(finished.revision).toBe(6);
  const rebuilt = new TaskQuestionStore(f.store.directory); expect(await rebuilt.get(f.question.id)).toEqual(finished);
  expect(await rebuilt.listIds()).toEqual([f.question.id]); expect((await rebuilt.begin(f.question.id, 'wake')).dispatch).toBe(false);
  expect((await fs.stat(f.store.directory)).mode & 0o777).toBe(0o700);
});

it('grants each dispatch intent once and never replays a recovered sending state', async () => {
  const f = await fixture();
  const outcomes = await Promise.all([f.store.begin(f.question.id, 'delivery'), f.store.begin(f.question.id, 'delivery')]);
  expect(outcomes.filter(value => value.dispatch)).toHaveLength(1);
  const rebuilt = new TaskQuestionStore(f.store.directory); expect((await rebuilt.begin(f.question.id, 'delivery')).dispatch).toBe(false);
  await rebuilt.uncertain(f.question.id, 'delivery'); expect((await rebuilt.begin(f.question.id, 'delivery')).dispatch).toBe(false);
  await rebuilt.confirmDelivery(f.question.id, f.receipt); await rebuilt.answer(f.question.id, f.answer);
  const waking = await Promise.all([rebuilt.begin(f.question.id, 'wake'), f.store.begin(f.question.id, 'wake')]);
  expect(waking.filter(value => value.dispatch)).toHaveLength(1);
  await rebuilt.uncertain(f.question.id, 'wake'); expect((await rebuilt.begin(f.question.id, 'wake')).dispatch).toBe(false);
  await rebuilt.confirmWake(f.question.id, 'reconciled-admission'); expect((await rebuilt.get(f.question.id))?.wake).toBe('delivered');
});

it('accepts only the confirmed card and expected actor/chat; exact repeat cannot overwrite an answer', async () => {
  const f = await fixture(); await expect(f.store.answer(f.question.id, f.answer)).rejects.toThrow('live task');
  await f.delivered();
  for (const patch of [{ actorId: 'other' }, { chatId: 'other' }, { messageId: 'other' }, { text: '' }]) {
    await expect(f.store.answer(f.question.id, { ...f.answer, ...patch })).rejects.toThrow('live task');
  }
  const actual = await f.store.answer(f.question.id, f.answer);
  expect(await f.store.answer(f.question.id, { ...f.answer, eventId: 'repeated-callback' })).toEqual(actual);
  await expect(f.store.answer(f.question.id, { ...f.answer, text: 'different' })).rejects.toThrow('already has');
});

it('refuses foreign routes and late receipts cannot expire or overwrite an accepted answer', async () => {
  const f = await fixture(); await f.store.begin(f.question.id, 'delivery');
  for (const patch of [{ chatId: 'other' }, { threadRootId: 'other' }, { replyRootId: null }]) {
    await expect(f.store.confirmDelivery(f.question.id, { ...f.receipt, ...patch })).rejects.toThrow('route');
  }
  await f.store.confirmDelivery(f.question.id, f.receipt); const answered = await f.store.answer(f.question.id, f.answer);
  expect(await f.store.uncertain(f.question.id, 'delivery')).toEqual(answered);
  expect(await f.store.confirmDelivery(f.question.id, f.receipt)).toEqual(answered);
  await expect(f.store.confirmDelivery(f.question.id, { ...f.receipt, messageId: 'different-card' })).rejects.toThrow('route');
});

it('keeps cancellation terminal while preserving facts about late in-flight delivery or wake', async () => {
  const f = await fixture(); await f.store.begin(f.question.id, 'delivery'); await f.store.cancel(f.question.id);
  expect((await f.store.confirmDelivery(f.question.id, f.receipt)).cancelled).toBe(true);
  await expect(f.store.answer(f.question.id, f.answer)).rejects.toThrow('live task');
  await expect(f.store.begin(f.question.id, 'wake')).rejects.toThrow('cancelled');
  const second = await fixture(); await second.delivered(); await second.store.answer(second.question.id, second.answer);
  await second.store.begin(second.question.id, 'wake'); await second.store.cancel(second.question.id);
  const late = await second.store.confirmWake(second.question.id, 'already-admitted'); expect(late.cancelled).toBe(true); expect(late.wake).toBe('delivered');
});

it('reconciles a committed answer after an unknown write ACK without waking or answering twice', async () => {
  const f = await fixture(); await f.delivered(); const { rename } = fs;
  const saving = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('lost answer ACK'); });
  await expect(f.store.answer(f.question.id, f.answer)).rejects.toThrow('answer ACK'); saving.mockRestore();
  const current = await f.store.answer(f.question.id, f.answer); expect(current.revision).toBe(4); expect(current.wake).toBe('pending');
  expect((await f.store.begin(f.question.id, 'wake')).dispatch).toBe(true); expect((await f.store.begin(f.question.id, 'wake')).dispatch).toBe(false);
});

it('retains an unknown persisted intent instead of granting a second dispatch after sync failure', async () => {
  const f = await fixture(), { open } = fs;
  const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args); if (args[0] === f.store.directory) { vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed')); } return handle;
  });
  await expect(f.store.begin(f.question.id, 'delivery')).rejects.toThrow('sync failed'); opening.mockRestore();
  expect((await f.store.begin(f.question.id, 'delivery')).dispatch).toBe(false); expect((await f.store.get(f.question.id))?.delivery).toBe('sending');
});

it('shares a canonical queue through parent aliases and keeps explicit plain-chat reply routing', async () => {
  const f = await fixture(), alias = join(f.root, 'alias'); await fs.symlink(f.root, alias);
  const second = new TaskQuestionStore(join(alias, 'questions'));
  const result = await Promise.all([second.begin(f.question.id, 'delivery'), f.store.begin(f.question.id, 'delivery')]);
  expect(result.filter(value => value.dispatch)).toHaveLength(1);
  const plain = { ...f.question, id: randomUUID(), threadRootId: undefined, replyRootId: null };
  await f.store.create(plain); await f.store.begin(plain.id, 'delivery');
  await expect(f.store.confirmDelivery(plain.id, { messageId: 'plain-card', chatId: plain.chatId })).rejects.toThrow('route');
  expect((await f.store.confirmDelivery(plain.id, { messageId: 'plain-card', chatId: plain.chatId, replyRootId: null })).delivery).toBe('delivered');
});

it('preserves known state on publication failure and rejects corrupt or redirected records', async () => {
  const f = await fixture(), file = join(f.store.directory, `${f.question.id}.json`), before = await fs.readFile(file);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('failed publication'));
  await expect(f.store.begin(f.question.id, 'delivery')).rejects.toThrow('publication'); expect(await fs.readFile(file)).toEqual(before);
  await fs.writeFile(file, '{partial'); await expect(f.store.get(f.question.id)).rejects.toThrow('restore');
  await fs.rm(file); const outside = join(f.root, 'outside'); await fs.writeFile(outside, before); await fs.symlink(outside, file);
  await expect(f.store.get(f.question.id)).rejects.toThrow('restore'); expect(await fs.readFile(outside)).toEqual(before);
});

it('does not expire waits or create polling timers; exact creation/read retries remain detached', async () => {
  const f = await fixture(); await f.delivered();
  const interval = vi.spyOn(globalThis, 'setInterval'), now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 365 * 24 * 60 * 60 * 1000);
  const value = await f.store.create({ ...f.question }); value.question.question = 'caller edit';
  expect((await f.store.get(f.question.id))?.question.question).toBe(f.question.question); expect(interval).not.toHaveBeenCalled();
  await expect(f.store.create({ ...f.question, question: 'different request' })).rejects.toThrow('different work');
  await f.store.answer(f.question.id, f.answer); expect((await f.store.get(f.question.id))?.wake).toBe('pending');
});
