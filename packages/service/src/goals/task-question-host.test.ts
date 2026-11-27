import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskQuestionStore, type GoalExecutionRequest, type GoalExecutionStart, type GoalRecord, type TaskQuestion, type TaskQuestionRecord } from '@disclaude/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTaskQuestionHost, createTaskQuestionHostPorts } from './task-question-host.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-question-host-')); roots.push(root);
  const store = new TaskQuestionStore(join(root, 'task-questions'));
  const goal: GoalRecord = { version: 1, id: randomUUID(), revision: 3, chatId: 'chat-1', projectRoot: root, status: 'paused',
    objective: 'Ship the cut', acceptance: [], progress: '', artifacts: [], createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z' };
  const question: TaskQuestion = { id: randomUUID(), taskKey: goal.id, question: 'Which dataset should this task use?', chatId: 'chat-1',
    actorId: 'user-1', sourceMessageId: 'om-source', projectRoot: root, threadRootId: 'omt-thread' };
  const goalExecution = {
    bindTaskQuestion: vi.fn((input: Readonly<TaskQuestion>, _goalId?: string) => Promise.resolve({ ...input, taskKey: goal.id })),
    authorizeTaskQuestionAnswer: vi.fn((_question: Readonly<TaskQuestion>, _callback: Readonly<{ actorId: string; messageId: string }>) => Promise.resolve(goal)),
    start: vi.fn((_request: Readonly<GoalExecutionRequest>, _action: 'activate' | 'resume') =>
      Promise.resolve({ record: { ...goal, revision: 4, status: 'active' }, handle: {} } as unknown as GoalExecutionStart)),
  };
  const ports = createTaskQuestionHostPorts({ store, goalExecution });
  const answered: TaskQuestionRecord = { version: 1, revision: 5, question, cancelled: false, delivery: 'delivered', cardMessageId: 'om-card',
    answer: { messageId: 'om-card', text: 'Use the public set', eventId: 'evt-1' }, wake: 'sending', updatedAt: '2026-11-27T00:00:00.000Z' };
  return { root, store, goal, question, goalExecution, ports, answered };
}

describe('task question host ports (#5591 G1)', () => {
  it('send phase re-derives the live Goal binding with the persisted taskKey as the only narrowing key', async () => {
    const f = fixture();
    expect(f.ports.store).toBe(f.store);
    await f.ports.authorize(f.question, 'send');
    expect(f.goalExecution.bindTaskQuestion).toHaveBeenCalledWith(f.question, f.goal.id);
    expect(f.goalExecution.authorizeTaskQuestionAnswer).not.toHaveBeenCalled();
  });
  it('send phase rejects when no live Goal turn owns the question or the binding names another Goal', async () => {
    const f = fixture();
    f.goalExecution.bindTaskQuestion.mockRejectedValueOnce(new Error('No live Goal turn of this user and Project owns this task question'));
    await expect(f.ports.authorize(f.question, 'send')).rejects.toThrow(/No live Goal turn/);
    f.goalExecution.bindTaskQuestion.mockResolvedValueOnce({ ...f.question, taskKey: randomUUID() } as TaskQuestion);
    await expect(f.ports.authorize(f.question, 'send')).rejects.toThrow(/not bound to a live Goal turn/);
  });
  it('answer phase requires the verified callback and re-checks the Goal record with it', async () => {
    const f = fixture();
    await expect(f.ports.authorize(f.question, 'answer')).rejects.toThrow(/requires the verified callback/);
    await f.ports.authorize(f.question, 'answer', { actorId: 'user-1', messageId: 'om-card' });
    expect(f.goalExecution.authorizeTaskQuestionAnswer).toHaveBeenCalledWith(f.question, { actorId: 'user-1', messageId: 'om-card' });
  });
  it('wake resumes the paused Goal through the regular start path using the answer callback as the user event', async () => {
    const f = fixture();
    await expect(f.ports.wake(f.answered)).resolves.toBe(`goal-resume:${f.goal.id}:r4`);
    expect(f.goalExecution.authorizeTaskQuestionAnswer).toHaveBeenCalledWith(f.question, { actorId: 'user-1', messageId: 'om-card' });
    expect(f.goalExecution.start).toHaveBeenCalledOnce();
    const [[request, action]] = f.goalExecution.start.mock.calls;
    expect(action).toBe('resume');
    expect(request).toEqual({ goalId: f.goal.id, expectedRevision: 3, chatId: 'chat-1', projectRoot: f.root, actorId: 'user-1',
      sourceMessageId: 'om-card', threadRootId: 'omt-thread' });
  });
  it('wake never starts a Goal the record-level re-check rejects or that has no Project root', async () => {
    const f = fixture();
    f.goalExecution.authorizeTaskQuestionAnswer.mockRejectedValueOnce(new Error('Goal no longer admits its task answer'));
    await expect(f.ports.wake(f.answered)).rejects.toThrow(/no longer admits/);
    f.goalExecution.authorizeTaskQuestionAnswer.mockResolvedValueOnce({ ...f.goal, projectRoot: undefined });
    await expect(f.ports.wake(f.answered)).rejects.toThrow(/no Project root/);
    await expect(f.ports.wake({ ...f.answered, answer: undefined, wake: 'none' })).rejects.toThrow(/answer is missing/);
    expect(f.goalExecution.start).not.toHaveBeenCalled();
  });
  it('admission is never re-derived from a sending/uncertain wake', async () => {
    const f = fixture();
    await expect(f.ports.admitted(f.answered)).resolves.toBeUndefined();
    expect(f.goalExecution.start).not.toHaveBeenCalled();
  });
  it('attaches to every Feishu channel exposing the hook and skips other channels', () => {
    const { ports } = fixture();
    const feishu = { id: 'feishu', configureTaskQuestions: vi.fn() }, extra = { id: 'feishu-team', configureTaskQuestions: vi.fn() };
    const wechat = { id: 'wechat', configureTaskQuestions: vi.fn() }, noHook = { id: 'feishu-legacy' };
    expect(attachTaskQuestionHost([feishu, wechat, noHook, extra], ports)).toBe(2);
    expect(feishu.configureTaskQuestions).toHaveBeenCalledWith(ports);
    expect(extra.configureTaskQuestions).toHaveBeenCalledWith(ports);
    expect(wechat.configureTaskQuestions).not.toHaveBeenCalled();
  });
});
