import { expect, it, vi } from 'vitest';
import type { TaskCompletionReport, UserMessageParams } from '@disclaude/core';
import { createTaskParentReporter } from './background-task-parent.js';

const report: TaskCompletionReport = { id: 'e13dcf6a-66e3-4c40-8799-7a93e3ad1b63', chatId: 'chat', actorId: 'actor',
  projectRoot: '/project', sourceMessageId: 'original', outcome: 'succeeded', summary: 'done', artifacts: ['one.txt'] };

it.each([undefined, 'topic'])('waits for actual parent admission in %s without granting user provenance', async topic => {
  let release!: () => void;
  const admission = new Promise<void>(resolve => { release = resolve; });
  const parent = { processMessage: vi.fn<(input: UserMessageParams) => Promise<void>>(() => admission), hasAdmittedInput: vi.fn(() => true) };
  const getParent = vi.fn(() => parent);
  let returned = false;
  const pending = createTaskParentReporter(getParent)({ ...report, ...(topic ? { threadRootId: topic } : {}) })
    .then(receipt => { returned = true; return receipt; });
  await Promise.resolve(); expect(returned).toBe(false); expect(parent.hasAdmittedInput).not.toHaveBeenCalled();
  release(); expect(await pending).toBe(`task-report-${report.id}`);
  const [[message]] = parent.processMessage.mock.calls;
  expect(message).toMatchObject({ chatId: 'chat', messageId: `task-report-${report.id}`, replyRootId: topic ?? null });
  expect(message).not.toHaveProperty('senderOpenId'); expect(message).not.toHaveProperty('runtimeSource');
  expect(message.threadRootId).toBe(topic);
  expect(JSON.parse((message.payload as string).split('\n')[1])).toMatchObject({ id: report.id, outcome: 'succeeded', artifacts: ['one.txt'] });
});

it('refuses a receipt when a completion exists for refused input or admission failed', async () => {
  const ignored = { processMessage: vi.fn().mockResolvedValue(undefined), hasAdmittedInput: () => false, turnCompleteFor: () => Promise.resolve() };
  await expect(createTaskParentReporter(() => ignored)(report)).rejects.toThrow('not admitted');
  const failed = { ...ignored, processMessage: vi.fn().mockRejectedValue(new Error('queue refused')) };
  await expect(createTaskParentReporter(() => failed)(report)).rejects.toThrow('queue refused');
  await expect(createTaskParentReporter(() => { throw new Error('runtime unavailable'); })(report)).rejects.toThrow('runtime unavailable');
});
