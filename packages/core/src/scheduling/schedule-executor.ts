/**
 * Schedule Executor Factory - Creates TaskExecutor for scheduled task execution.
 *
 * Issue #1382: Unified executor implementation for both Primary Node and Worker Node.
 * Issue #2941: Uses ChatAgent directly since it is the only agent type.
 *
 * This module provides a factory function to create TaskExecutor instances
 * that can be used with the Scheduler. The executor uses a provided agent
 * factory to create short-lived ChatAgent instances for task execution.
 *
 * Architecture:
 * ```
 * createScheduleExecutor(agentFactory) => TaskExecutor
 *
 * Scheduler uses TaskExecutor to execute tasks:
 *   executor(chatId, prompt, userId)
 *     -> agentFactory(chatId, callbacks)
 *       -> chatAgent.executeOnce(chatId, prompt, undefined, userId)
 *         -> chatAgent.dispose()
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import type { ChatAgent } from '../agents/types.js';
import type { SchedulerCallbacks, TaskExecutor } from './scheduler.js';

/**
 * Factory function type for creating short-lived ChatAgent instances.
 *
 * Issue #2941: Since ChatAgent is the only agent type, this directly
 * returns a ChatAgent instance.
 *
 * @param chatId - Chat ID for message delivery
 * @param callbacks - Callbacks for sending messages
 * @param model - Optional model override for this task (Issue #1338)
 * @returns A ChatAgent instance (caller must dispose)
 */
export type AgentFactory = (
  chatId: string,
  callbacks: SchedulerCallbacks,
  model?: string
) => ChatAgent;

/**
 * Options for creating a schedule executor.
 */
export interface ScheduleExecutorOptions {
  /** Factory function to create ChatAgent instances for task execution */
  agentFactory: AgentFactory;
  /** Callbacks for sending messages (used for error handling) */
  callbacks: SchedulerCallbacks;
}

/**
 * Create a TaskExecutor for scheduled task execution.
 *
 * This factory function creates an executor that:
 * 1. Creates a short-lived ChatAgent using the provided factory
 * 2. Executes the task via chatAgent.executeOnce()
 * 3. Disposes the ChatAgent after execution (success or failure)
 *
 * Issue #1382: This enables both Primary Node and Worker Node to use
 * the same executor logic, just with different agent factories.
 * Issue #2941: Uses ChatAgent directly.
 *
 * @param options - Executor options including agent factory and callbacks
 * @returns A TaskExecutor function for use with Scheduler
 *
 * @example
 * ```typescript
 * // In Primary Node or Worker Node:
 * const executor = createScheduleExecutor({
 *   agentFactory: (chatId, callbacks) => {
 *     return AgentFactory.createAgent(chatId, callbacks);
 *   },
 *   callbacks: { sendMessage: async (chatId, msg) => { ... } },
 * });
 *
 * const scheduler = new Scheduler({
 *   scheduleManager,
 *   callbacks,
 *   executor,
 * });
 * ```
 */
export function createScheduleExecutor(options: ScheduleExecutorOptions): TaskExecutor {
  const { agentFactory, callbacks } = options;

  return async (chatId: string, prompt: string, userId?: string, model?: string): Promise<void> => {
    // Create a short-lived ChatAgent for this execution
    // Issue #1338: Pass model override for per-task model selection
    const agent = agentFactory(chatId, callbacks, model);

    try {
      await agent.executeOnce(chatId, prompt, undefined, userId); // messageId is always undefined for scheduled tasks
    } finally {
      // Always dispose the ChatAgent after execution
      agent.dispose();
    }
  };
}
