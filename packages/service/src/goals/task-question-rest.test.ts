import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskQuestionStore, type TaskQuestion, type TaskQuestionRecord } from '@disclaude/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskQuestionFlow } from '../agents/task-question-flow.js';
import { createTaskQuestionHostPorts } from './task-question-host.js';
import { createTaskQuestionHostHandlers, isTaskQuestionAskRequest, TaskQuestionRequestError } from './task-question-rest.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-question-rest-')); roots.push(root);
  const goalId = randomUUID();
  const request = { chatId: 'chat-1', actorId: 'user-1', projectRoot: root, sourceMessageId: 'om-source',
    question: 'Which dataset should this task use?', threadRootId: 'omt-thread' };
  const bindTaskQuestion = vi.fn((input: Readonly<TaskQuestion>, _goalId?: string) => Promise.resolve({ ...input, taskKey: goalId }));
  const channel = { requestTaskQuestion: vi.fn((_question: TaskQuestion) =>
    Promise.resolve({ version: 1, revision: 2, question: { ..._question, taskKey: goalId }, cancelled: false, delivery: 'delivered', wake: 'none', updatedAt: '2026-11-27T22:00:00.000Z' } as TaskQuestionRecord)) };
  const resolveChannel = vi.fn((_chatId: string) => channel as { requestTaskQuestion(question: TaskQuestion): Promise<TaskQuestionRecord> } | undefined);
  const handlers = createTaskQuestionHostHandlers({ goalExecution: { bindTaskQuestion }, resolveChannel });
  return { root, goalId, request, bindTaskQuestion, channel, resolveChannel, handlers };
}

describe('POST /api/task-questions body (#5591 G1)', () => {
  it('accepts a claim-shaped ask and rejects anything the store could not bind', () => {
    const { request } = fixture();
    expect(isTaskQuestionAskRequest(request)).toBe(true);
    expect(isTaskQuestionAskRequest({ ...request, goalId: randomUUID(), replyRootId: null })).toBe(true);
    for (const bad of [null, [], 'ask', { ...request, actorId: '' }, { ...request, question: '  ' }, { ...request, projectRoot: './relative' },
      { ...request, sourceMessageId: 7 }, { ...request, goalId: '' }, { ...request, threadRootId: '' }, { ...request, replyRootId: 3 }]) {
      expect(isTaskQuestionAskRequest(bad)).toBe(false);
    }
  });
});

describe('task question host handlers (#5591 G1)', () => {
  it('binds first with a host-generated id, then hands only the bound question to the chat channel', async () => {
    const f = fixture();
    const record = await f.handlers.ask(f.request);
    expect(record.question.taskKey).toBe(f.goalId);
    expect(f.bindTaskQuestion).toHaveBeenCalledOnce();
    const [[question, goalId]] = f.bindTaskQuestion.mock.calls;
    expect(goalId).toBeUndefined();
    expect(question).toMatchObject({ question: f.request.question, chatId: 'chat-1', actorId: 'user-1', projectRoot: f.root,
      sourceMessageId: 'om-source', threadRootId: 'omt-thread', taskKey: 'pending-bind' });
    expect(question.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.resolveChannel).toHaveBeenCalledExactlyOnceWith('chat-1');
    // The channel never sees the placeholder key: only the Goal id the trusted binding chose.
    expect(f.channel.requestTaskQuestion).toHaveBeenCalledExactlyOnceWith({ ...question, taskKey: f.goalId });
    expect((await f.handlers.ask(f.request)).question.id).not.toBe(question.id);
  });
  it('passes goalId only as a narrowing hint for the trusted binding', async () => {
    const f = fixture();
    await f.handlers.ask({ ...f.request, goalId: f.goalId, replyRootId: null });
    expect(f.bindTaskQuestion.mock.calls[0][1]).toBe(f.goalId);
    expect(f.bindTaskQuestion.mock.calls[0][0]).toMatchObject({ taskKey: f.goalId, replyRootId: null });
  });
  it('a body no live Goal turn owns is rejected before any card is requested, without reflecting host text', async () => {
    const f = fixture();
    f.bindTaskQuestion.mockRejectedValueOnce(new Error('ENOENT: no such file, open \'/secrets/goals/x.json\''));
    const failure = await f.handlers.ask(f.request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaskQuestionRequestError);
    expect(failure).toMatchObject({ status: 409, reason: 'rejected', message: 'No live Goal turn of this user and Project admits this task question' });
    expect(String((failure as Error).message)).not.toContain('/secrets');
    expect(f.resolveChannel).not.toHaveBeenCalled();
    expect(f.channel.requestTaskQuestion).not.toHaveBeenCalled();
  });
  it('a bound question without a running Feishu channel for its chat is unavailable, not sent elsewhere', async () => {
    const f = fixture();
    f.resolveChannel.mockReturnValueOnce(undefined);
    await expect(f.handlers.ask(f.request)).rejects.toMatchObject({ status: 503, reason: 'unavailable' });
    expect(f.channel.requestTaskQuestion).not.toHaveBeenCalled();
  });
  it('runs through the real TaskQuestionFlow: the bound ask reaches send, a forged one never does', async () => {
    const f = fixture();
    const store = new TaskQuestionStore(join(f.root, 'task-questions'));
    const send = vi.fn(() => Promise.resolve({ messageId: 'om-card', chatId: 'chat-1', threadRootId: 'omt-thread' }));
    const flow = new TaskQuestionFlow({ ...createTaskQuestionHostPorts({ store, goalExecution: { bindTaskQuestion: f.bindTaskQuestion,
      authorizeTaskQuestionAnswer: vi.fn(), start: vi.fn() } }), send,
      reconcileCard: () => Promise.resolve({ messageId: 'om-card', chatId: 'chat-1' }) });
    const handlers = createTaskQuestionHostHandlers({ goalExecution: { bindTaskQuestion: f.bindTaskQuestion }, resolveChannel: () => ({ requestTaskQuestion: q => flow.ask(q) }) });
    const record = await handlers.ask(f.request);
    expect(record.delivery).toBe('delivered');
    expect((await store.get(record.question.id))?.question.taskKey).toBe(f.goalId);
    expect(send).toHaveBeenCalledOnce();
    f.bindTaskQuestion.mockRejectedValueOnce(new Error('No live Goal turn of this user and Project owns this task question'));
    await expect(handlers.ask(f.request)).rejects.toBeInstanceOf(TaskQuestionRequestError);
    expect(send).toHaveBeenCalledOnce();
    expect(await store.listIds()).toHaveLength(1);
  });
});
