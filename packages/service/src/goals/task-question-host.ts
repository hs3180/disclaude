import type { TaskQuestionStore } from '@disclaude/core';
import type { TaskQuestionFlowPorts } from '../agents/task-question-flow.js';
import type { GoalExecutionService } from './goal-execution-service.js';

export type TaskQuestionGoalExecution = Pick<GoalExecutionService,
  'bindTaskQuestion' | 'authorizeTaskQuestionAnswer' | 'start'>;

export interface TaskQuestionHostOptions {
  store: TaskQuestionStore;
  goalExecution: TaskQuestionGoalExecution;
}

/** Default host ports for task questions (#5591 G1). No injected model tool:
 * a live Goal turn asks through the host CLI/REST entry, which first binds
 * the question with `bindTaskQuestion`; these ports only re-derive that
 * binding from the frozen question, re-check the Goal record against the
 * verified answer callback, and resume the paused Goal through the regular
 * start path (authorized again by the Goal service before any turn runs).
 */
export function createTaskQuestionHostPorts(options: TaskQuestionHostOptions): Omit<TaskQuestionFlowPorts, 'send' | 'reconcileCard'> {
  const { store, goalExecution } = options;
  return {
    store,
    async authorize(question, phase, answer) {
      if (phase === 'send') {
        // The persisted taskKey must be exactly the Goal the trusted live
        // binding selects; a caller-chosen key can narrow, never widen, it.
        const bound = await goalExecution.bindTaskQuestion(question, question.taskKey);
        if (bound.taskKey !== question.taskKey) { throw new Error('Task question is not bound to a live Goal turn'); }
        return;
      }
      if (!answer) { throw new Error('Task answer phase requires the verified callback'); }
      await goalExecution.authorizeTaskQuestionAnswer(question, answer);
    },
    async wake(record) {
      const { answer } = record;
      if (!answer) { throw new Error('Task answer is missing'); }
      const callback = { actorId: record.question.actorId, messageId: answer.messageId };
      const goal = await goalExecution.authorizeTaskQuestionAnswer(record.question, callback);
      const { projectRoot } = goal;
      if (projectRoot === undefined) { throw new Error('Goal has no Project root'); }
      const start = await goalExecution.start({ goalId: goal.id, expectedRevision: goal.revision, chatId: goal.chatId, projectRoot,
        actorId: callback.actorId, sourceMessageId: callback.messageId,
        ...(record.question.threadRootId ? { threadRootId: record.question.threadRootId } : {}) }, 'resume');
      return `goal-resume:${start.record.id}:r${start.record.revision}`;
    },
    // Admission of an answer is confirmed only by the wake receipt above. A
    // sending/uncertain wake has no independent admission evidence and is
    // never re-dispatched here; the user's /goal path remains the manual route.
    admitted: () => Promise.resolve(undefined),
  };
}

/** Configure every running Feishu channel that exposes the task-question hook. */
export function attachTaskQuestionHost(
  channels: readonly { id: string; configureTaskQuestions?: (ports: Omit<TaskQuestionFlowPorts, 'send' | 'reconcileCard'>) => void }[],
  ports: Omit<TaskQuestionFlowPorts, 'send' | 'reconcileCard'>
): number {
  let attached = 0;
  for (const channel of channels) {
    if (channel.id.startsWith('feishu') && typeof channel.configureTaskQuestions === 'function') {
      channel.configureTaskQuestions(ports);
      attached += 1;
    }
  }
  return attached;
}
