/**
 * Schedule Executor Factory - Creates TaskExecutor for scheduled task execution.
 *
 * Issue #1382: Unified executor implementation for both Primary Node and Worker Node.
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
 *   executor(chatId, prompt, userId)
 *     -> agentFactory(chatId, callbacks)
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
 * Issue #2513: Renamed from ScheduleAgent to TaskAgentInterface — all agents
 * are ChatAgent, this is just a structural interface for the executor.
 */
export interface TaskAgentInterface {
  /** Execute the task once with the given prompt */
  executeOnce: (chatId: string, prompt: string, messageId?: string, userId?: string) => Promise<void>;
  /** Dispose the agent after execution */
  dispose: () => void;
}

/**
 * Factory function type for creating agent instances.
 *
 * @param chatId - Chat ID for message delivery
 * @param callbacks - Callbacks for sending messages
 * @param model - Optional model override for this task (Issue #1338)
 * @returns An agent instance (caller must dispose)
 */
export type TaskAgentFactory = (
  chatId: string,
  callbacks: SchedulerCallbacks,
  model?: string
) => TaskAgentInterface;

/**
 * @deprecated Use TaskAgentInterface instead. Issue #2513.
 */
export type ScheduleAgent = TaskAgentInterface;

/**
 * @deprecated Use TaskAgentFactory instead. Issue #2513.
 */
export type ScheduleAgentFactory = TaskAgentFactory;

/**
 * Options for creating a schedule executor.
 */
export interface ScheduleExecutorOptions {
  /** Factory function to create agent instances */
  agentFactory: TaskAgentFactory;
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
    // Create a short-lived agent for this execution
    // Issue #1338: Pass model override for per-task model selection
    const agent = agentFactory(chatId, callbacks, model);

    try {
      await agent.executeOnce(chatId, prompt, undefined, userId); // messageId is always undefined for scheduled tasks
    } finally {
      // Always dispose the agent after execution
      agent.dispose();
    }
  };
}
