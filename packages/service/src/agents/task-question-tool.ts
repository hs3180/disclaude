import type { TaskQuestion, ToolDefinition } from '@disclaude/core';
import type { TaskQuestionFlow } from './task-question-flow.js';

/** Register on one actual worker with a host-created ID and authenticated source.
 * No future-answer promise is attached to the worker's native query lifetime.
 */
export function createTaskQuestionTool(flow: Pick<TaskQuestionFlow, 'ask'>, binding: Omit<TaskQuestion, 'question'>): ToolDefinition {
  const source = structuredClone(binding);
  return {
    name: 'board_wait_for_user',
    description: 'Ask one public business-feedback question for this fixed task. Do not request credentials or private input. The host confirms actual delivery; then end this worker turn so other tasks can continue. A later answer is routed to this original task by the host. No owner, recipient or task identity can be supplied here.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: {
      question: { type: 'string', minLength: 1, maxLength: 16000 },
    } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['questionId', 'delivered', 'answered'], properties: {
      questionId: { type: 'string' }, delivered: { type: 'boolean' }, answered: { type: 'boolean' },
    } },
    execute: async (input, context) => {
      context.signal.throwIfAborted();
      if (Object.keys(input).some(key => key !== 'question') || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 16000) { throw new Error('Invalid public task question'); }
      const record = await flow.ask({ ...source, question: input.question });
      context.signal.throwIfAborted();
      return { questionId: record.question.id, delivered: record.delivery === 'delivered', answered: !!record.answer };
    },
  };
}
