/**
 * Schedule Executor Factory - Creates TaskExecutor for scheduled task execution.
 *
 * Issue #1382: Unified executor implementation for both Primary Node and Worker Node.
 * Issue #2941: Uses ChatAgent directly since it is the only agent type.
 * Issue #3124: Uses processMessage + taskComplete instead of executeOnce,
 *   unifying scheduled tasks on the streaming input path.
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
 *       -> chatAgent.processMessage(chatId, prompt, messageId, userId)
 *       -> await chatAgent.taskComplete
 *       -> chatAgent.dispose()
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import type { ChatAgent } from '../agents/types.js';
import type { SchedulerCallbacks, TaskExecutor } from './scheduler.js';
import type { ModelTier } from '../config/types.js';

/**
 * Factory function type for creating short-lived ChatAgent instances.
 *
 * Issue #2941: Since ChatAgent is the only agent type, this directly
 * returns a ChatAgent instance.
 *
 * @param chatId - Chat ID for message delivery
 * @param callbacks - Callbacks for sending messages
 * @param model - Optional model override for this task (Issue #1338)
 * @param modelTier - Optional model tier for tier-based selection (Issue #3059)
 * @returns A ChatAgent instance (caller must dispose)
 */
export type AgentFactory = (
  chatId: string,
  callbacks: SchedulerCallbacks,
  model?: string,
  modelTier?: ModelTier
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
 * 2. Executes the task via processMessage() + taskComplete (Issue #3124)
 * 3. Disposes the ChatAgent after execution (success or failure)
 *
 * Issue #1382: This enables both Primary Node and Worker Node to use
 * the same executor logic, just with different agent factories.
 * Issue #2941: Uses ChatAgent directly.
 * Issue #3124: Unified on streaming input path (processMessage + taskComplete).
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

  return async (chatId: string, prompt: string, userId?: string, model?: string, modelTier?: ModelTier): Promise<void> => {
    // Create a short-lived ChatAgent for this execution
    // Issue #1338: Pass model override for per-task model selection
    // Issue #3059: Pass modelTier for tier-based model selection
    const agent = agentFactory(chatId, callbacks, model, modelTier);

    try {
      // Issue #3124: Use processMessage + taskComplete instead of executeOnce.
      // This unifies scheduled tasks on the streaming input path, eliminating
      // the duplicated MCP config, message building, and iterator processing.
      const messageId = `sched-${Date.now()}`;
      await agent.processMessage(chatId, prompt, messageId, userId);

      // Wait for the task to complete via the streaming path
      if (agent.taskComplete) {
        await agent.taskComplete;
      }
    } finally {
      // Always dispose the ChatAgent after execution
      agent.dispose();
    }
  };
}
