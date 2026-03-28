/**
 * Schedule Executor Factory - Creates TaskExecutor for scheduled task execution.
 *
 * Issue #1382: Unified executor implementation for both Primary Node and Worker Node.
 * Issue #1315: Support for per-task SOUL.md personality injection.
 *
 * This module provides a factory function to create TaskExecutor instances
 * that can be used with the Scheduler. The executor uses a provided agent
 * factory to create short-lived agents for task execution.
 *
 * Architecture:
 * ```
 * createScheduleExecutor(agentFactory) => TaskExecutor
 *
 * Scheduler uses TaskExecutor to execute tasks:
 *   executor(chatId, prompt, userId, model, systemPromptAppend)
 *     -> agentFactory(chatId, callbacks, model, systemPromptAppend)
 *       -> agent.executeOnce(chatId, prompt, undefined, userId)
 *         -> agent.dispose()
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import type { SchedulerCallbacks, TaskExecutor } from './scheduler.js';

/**
 * Interface for an agent that can execute scheduled tasks.
 *
 * This is a minimal interface that ChatAgent naturally satisfies.
 * The executeOnce signature matches ChatAgent.executeOnce(chatId, text, messageId?, senderOpenId?)
 * to enable structural typing without type assertions.
 *
 * Issue #1446: Fixed signature to be compatible with ChatAgent implementation.
 */
export interface ScheduleAgent {
  /** Execute the task once with the given prompt */
  executeOnce: (chatId: string, prompt: string, messageId?: string, userId?: string) => Promise<void>;
  /** Dispose the agent after execution */
  dispose: () => void;
}

/**
 * Factory function type for creating ScheduleAgent instances.
 *
 * @param chatId - Chat ID for message delivery
 * @param callbacks - Callbacks for sending messages
 * @param model - Optional model override for this task (Issue #1338)
 * @param systemPromptAppend - Optional system prompt append for SOUL.md injection (Issue #1315)
 * @returns A ScheduleAgent instance (caller must dispose)
 */
export type ScheduleAgentFactory = (
  chatId: string,
  callbacks: SchedulerCallbacks,
  model?: string,
  systemPromptAppend?: string
) => ScheduleAgent;

/**
 * Options for creating a schedule executor.
 */
export interface ScheduleExecutorOptions {
  /** Factory function to create ScheduleAgent instances */
  agentFactory: ScheduleAgentFactory;
  /** Callbacks for sending messages (used for error handling) */
  callbacks: SchedulerCallbacks;
}

/**
 * Create a TaskExecutor for scheduled task execution.
 *
 * This factory function creates an executor that:
 * 1. Creates a short-lived agent using the provided factory
 * 2. Executes the task via agent.executeOnce()
 * 3. Disposes the agent after execution (success or failure)
 *
 * Issue #1382: This enables both Primary Node and Worker Node to use
 * the same executor logic, just with different agent factories.
 * Issue #1315: Passes systemPromptAppend for SOUL.md personality injection.
 *
 * @param options - Executor options including agent factory and callbacks
 * @returns A TaskExecutor function for use with Scheduler
 *
 * @example
 * ```typescript
 * // In Primary Node or Worker Node:
 * const executor = createScheduleExecutor({
 *   agentFactory: (chatId, callbacks, model, systemPromptAppend) => {
 *     return AgentFactory.createScheduleAgent(chatId, callbacks, {
 *       model,
 *       systemPromptAppend,
 *     });
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

  return async (chatId: string, prompt: string, userId?: string, model?: string, systemPromptAppend?: string): Promise<void> => {
    // Create a short-lived agent for this execution
    // Issue #1338: Pass model override for per-task model selection
    // Issue #1315: Pass systemPromptAppend for SOUL.md personality injection
    const agent = agentFactory(chatId, callbacks, model, systemPromptAppend);

    try {
      await agent.executeOnce(chatId, prompt, undefined, userId); // messageId is always undefined for scheduled tasks
    } finally {
      // Always dispose the agent after execution
      agent.dispose();
    }
  };
}
