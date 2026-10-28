import { AgentTaskRunner } from '../agents/agent-task-runner.js';
import { createAgentTaskTool } from '../agents/agent-task-tool.js';
import type { NativeGoalTurnTools } from '../agents/native-goal-executor.js';
import type { GoalTurnToolScope } from './goal-execution-service.js';

/** Synchronous children belong to this Goal round. Detached execution needs a
 * separate owner; it must not be added to this bundle's cleanup lifetime.
 */
export function createGoalTaskTurnTools(scope: GoalTurnToolScope): NativeGoalTurnTools {
  const runtime = scope.runtimeOptions();
  const runner = new AgentTaskRunner({ ...runtime, configureQueryOptions: options => {
    const configured = runtime.configureQueryOptions?.(options) ?? options;
    // The parent keeps its slot while awaiting this child. Queueing behind it
    // can deadlock; refuse admission without changing the configured limits.
    return { ...configured, capacityAdmission: 'reject', onAsyncUserInputAnswer: undefined };
  } });
  const { source } = scope;
  const task = createAgentTaskTool(runner, {
    projectRoot: source.projectRoot, callbacks: scope.callbacks,
    source: { chatId: source.chatId, senderOpenId: source.actorId, sourceMessageId: source.sourceMessageId,
      ...(source.chatType ? { chatType: source.chatType } : {}),
      ...(source.threadRootId ? { threadRootId: source.threadRootId } : {}) },
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed = true;
    closing ??= runner.close();
    return closing;
  };
  return { tools: [{ ...task, execute: async (input, context) => {
    context.signal.throwIfAborted();
    if (closed) { throw new Error('Goal task tools are closed'); }
    await scope.authorize();
    context.signal.throwIfAborted();
    if (closed) { throw new Error('Goal task tools are closed'); }
    const result = await task.execute(input, context);
    await scope.authorize();
    return result;
  } }],
  // Retain the same promise for final cleanup; an abort listener cannot throw
  // an unhandled asynchronous rejection while the native query is unwinding.
  stop: () => { void close().catch(() => {}); }, close };
}
