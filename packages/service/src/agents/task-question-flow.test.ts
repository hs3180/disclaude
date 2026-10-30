import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskQuestionStore, type TaskQuestion } from '@disclaude/core';
import { TaskQuestionFlow, taskQuestionReadiness, type TaskQuestionFlowPorts } from './task-question-flow.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'task-question-flow-')); roots.push(root);
  const store = new TaskQuestionStore(join(root, 'questions'));
  const question: TaskQuestion = { id: randomUUID(), taskKey: 'task-A', question: 'Which dataset?', chatId: 'chat-A', actorId: 'actor-A',
    sourceMessageId: 'source-A', projectRoot: '/project/A', threadRootId: 'topic-A', replyRootId: 'topic-A' };
  const receipt = { messageId: 'actual-card', chatId: question.chatId, threadRootId: question.threadRootId, replyRootId: question.replyRootId };
  const answer = { messageId: receipt.messageId, actorId: question.actorId, chatId: question.chatId, text: 'Verified dataset', eventId: 'actual-event' };
  const authorize = vi.fn(), send = vi.fn(() => Promise.resolve(receipt)), reconcileCard = vi.fn(() => Promise.resolve(receipt));
  const wake = vi.fn(() => Promise.resolve('actual-parent-admission')), admitted = vi.fn(() => Promise.resolve('actual-parent-admission'));
  const ports: TaskQuestionFlowPorts = { store, authorize, send, reconcileCard, wake, admitted };
  const flow = new TaskQuestionFlow(ports);
  return { root, store, question, receipt, answer, authorize, send, reconcileCard, wake, admitted, ports, flow };
}

it('releases finite question operations while another task stays ready; all waiting needs no model/polling', async () => {
  const f = await fixture(), interval = vi.spyOn(globalThis, 'setInterval');
  const waiting = await f.flow.ask(f.question); await Promise.resolve();
  expect(f.flow.busy).toBe(false); expect(waiting.delivery).toBe('delivered');
  expect(taskQuestionReadiness(['task-A', 'task-B'], [waiting], 0)).toMatchObject({ ready: ['task-B'], waiting: ['task-A'], state: 'runnable' });
  expect(taskQuestionReadiness(['task-A'], [waiting], 0)).toMatchObject({ ready: [], state: 'waiting' });
  expect(interval).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
  await f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer); expect(f.wake).not.toHaveBeenCalled();
  const done = await f.flow.wake(f.question.id); expect(done.wake).toBe('delivered');
  await f.flow.wake(f.question.id); expect(f.wake).toHaveBeenCalledOnce();
  expect(taskQuestionReadiness(['task-A'], [done], 0).ready).toEqual(['task-A']);
});

it('never resends uncertain delivery; a verified early callback can reconcile the actual card', async () => {
  const f = await fixture(); f.send.mockRejectedValueOnce(new Error('unknown send ACK'));
  await expect(f.flow.ask(f.question)).rejects.toThrow('not confirmed');
  await expect(f.flow.ask(f.question)).rejects.toThrow('no card was resent'); expect(f.send).toHaveBeenCalledOnce();
  const answer = await f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer);
  expect(f.reconcileCard).toHaveBeenCalledOnce(); expect(answer.delivery).toBe('delivered'); expect(answer.answer?.text).toBe(f.answer.text);
});

it('does not erase an early accepted answer when the original send later fails', async () => {
  const f = await fixture(), sent = deferred();
  f.send.mockImplementationOnce(async () => { await sent.promise; throw new Error('late lost ACK'); });
  const sending = f.flow.ask(f.question);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  await f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer); sent.resolve();
  const final = await sending; expect(final.answer?.text).toBe(f.answer.text); expect(final.wake).toBe('pending');
});

it('rejects foreign actor/card/route before accepting an answer or waking', async () => {
  const f = await fixture(); await f.flow.ask(f.question);
  for (const extra of [{ actorId: 'foreign' }, { chatId: 'foreign' }, { messageId: 'foreign' }]) {
    await expect(f.flow.acceptAuthenticatedAnswer(f.question.id, { ...f.answer, ...extra })).rejects.toThrow();
  }
  expect(f.reconcileCard).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
  const other = await fixture(); other.send.mockRejectedValueOnce(new Error('lost ACK')); await expect(other.flow.ask(other.question)).rejects.toThrow();
  other.reconcileCard.mockResolvedValueOnce({ ...other.receipt, replyRootId: 'wrong-topic' });
  await expect(other.flow.acceptAuthenticatedAnswer(other.question.id, other.answer)).rejects.toThrow('route');
});

it('reconciles uncertain parent admission by reading, without sending the answer twice', async () => {
  const f = await fixture(); await f.flow.ask(f.question); await f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer);
  f.wake.mockRejectedValueOnce(new Error('ACK lost after actual parent admission'));
  await expect(f.flow.wake(f.question.id)).rejects.toThrow('not confirmed');
  await expect(f.flow.wake(f.question.id)).rejects.toThrow('no input was repeated'); expect(f.wake).toHaveBeenCalledOnce();
  expect((await f.flow.reconcileWake(f.question.id)).wake).toBe('delivered'); expect(f.admitted).toHaveBeenCalledOnce();
});

it('retains an answer while current Project/Goal authority disallows waking', async () => {
  const f = await fixture(); await f.flow.ask(f.question); await f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer);
  f.authorize.mockImplementationOnce(() => { throw new Error('Goal is paused or Project changed'); });
  await expect(f.flow.wake(f.question.id)).rejects.toThrow('paused'); expect(f.wake).not.toHaveBeenCalled();
  expect((await f.store.get(f.question.id))?.wake).toBe('pending');
  await f.flow.wake(f.question.id); expect(f.wake).toHaveBeenCalledOnce();
});

it('defers a known-unsent wake on a late pause and retries only after authority is restored', async () => {
  const f = await fixture(); await f.flow.ask(f.question); await f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer);
  let checks = 0;
  f.authorize.mockImplementation((_question, phase) => { if (phase === 'wake' && ++checks === 2) { throw new Error('paused before actual dispatch'); } });
  await expect(f.flow.wake(f.question.id)).rejects.toThrow('not confirmed'); expect(f.wake).not.toHaveBeenCalled();
  expect((await f.store.get(f.question.id))?.wake).toBe('pending');
  await f.flow.wake(f.question.id); expect(f.wake).toHaveBeenCalledOnce();
});

it('keeps cancelled questions closed and reports delivery problems as reconciliation work', async () => {
  const f = await fixture(); await f.flow.ask(f.question); await f.store.cancel(f.question.id);
  await expect(f.flow.acceptAuthenticatedAnswer(f.question.id, f.answer)).rejects.toThrow('live task');
  await expect(f.flow.wake(f.question.id)).rejects.toThrow('cancelled');
  const other = await fixture(); other.send.mockRejectedValueOnce(new Error('lost ACK')); await expect(other.flow.ask(other.question)).rejects.toThrow();
  expect(taskQuestionReadiness(['task-A'], [(await other.store.get(other.question.id))!], 0).state).toBe('needs-reconciliation');
});

it('drains an already-started send on shutdown and prevents a new send after pending authorization', async () => {
  const f = await fixture(), gate = deferred(); f.send.mockImplementationOnce(async () => { await gate.promise; return f.receipt; });
  const asking = f.flow.ask(f.question); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  let closed = false; const closing = f.flow.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); await expect(f.flow.ask(f.question)).rejects.toThrow('closing');
  gate.resolve(); await asking; await closing; expect((await f.store.get(f.question.id))?.cancelled).toBe(false);
  const second = await fixture(), permission = deferred(); second.authorize.mockImplementationOnce(() => permission.promise);
  const pending = second.flow.ask(second.question), stopped = second.flow.close(); permission.resolve();
  await expect(pending).rejects.toThrow('closing'); await stopped; expect(second.send).not.toHaveBeenCalled();
});

