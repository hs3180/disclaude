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
 *   executor(chatId, prompt, userId, model, soulPath)
 *     -> SoulLoader.load(soulPath)  // if per-task soul configured
 *     -> agentFactory(chatId, callbacks, model, perTaskSoulContent)
 *       -> agent.executeOnce(chatId, prompt, undefined, userId)
 *         -> agent.dispose()
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import { createLogger } from '../utils/logger.js';
import { SoulLoader } from '../soul/loader.js';
import type { SchedulerCallbacks, TaskExecutor } from './scheduler.js';

const logger = createLogger('ScheduleExecutor');

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
 * @param systemPromptAppend - Optional per-task soul content override (Issue #1315).
 *   When provided, overrides the global SOUL.md for this task only.
 *   When undefined, the caller should fall back to the global SOUL.md.
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
 * 1. If per-task soul is configured, loads the SOUL.md file
 * 2. Creates a short-lived agent using the provided factory
 * 3. Executes the task via agent.executeOnce()
 * 4. Disposes the agent after execution (success or failure)
 *
 * Issue #1382: This enables both Primary Node and Worker Node to use
 * the same executor logic, just with different agent factories.
 * Issue #1315: Per-task soul override support.
 *
 * @param options - Executor options including agent factory and callbacks
 * @returns A TaskExecutor function for use with Scheduler
 *
 * @example
 * ```typescript
 * // In Primary Node or Worker Node:
 * const executor = createScheduleExecutor({
 *   agentFactory: (chatId, callbacks, model, systemPromptAppend) => {
 *     // systemPromptAppend is per-task soul content (or undefined for global)
 *     const effectiveSoul = systemPromptAppend ?? globalSoulContent;
 *     return AgentFactory.createScheduleAgent(chatId, callbacks, {
 *       ...(model ? { model } : {}),
 *       systemPromptAppend: effectiveSoul,
 *     });
 *   },
 *   callbacks: { sendMessage: async (chatId, msg) => { ... } },
 * });
 * ```
 */
export function createScheduleExecutor(options: ScheduleExecutorOptions): TaskExecutor {
  const { agentFactory, callbacks } = options;

  return async (chatId: string, prompt: string, userId?: string, model?: string, soul?: string): Promise<void> => {
    // Issue #1315: Load per-task soul if configured
    let perTaskSoulContent: string | undefined;

    if (soul) {
      const loader = new SoulLoader(soul);
      const result = await loader.load();

      if (result && 'content' in result) {
        perTaskSoulContent = result.content;
        logger.info({ path: result.resolvedPath }, 'Per-task SOUL.md loaded for scheduled task');
      } else if (result && 'reason' in result) {
        logger.warn(
          { reason: result.reason, message: result.message, path: soul },
          'Failed to load per-task SOUL.md, falling back to global soul',
        );
      }
      // If null, file not found - silent fallback to global soul
    }

    // Create a short-lived agent for this execution
    // Issue #1338: Pass model override for per-task model selection
    // Issue #1315: Pass per-task soul content (overrides global soul when set)
    const agent = agentFactory(chatId, callbacks, model, perTaskSoulContent);

    try {
      await agent.executeOnce(chatId, prompt, undefined, userId); // messageId is always undefined for scheduled tasks
    } finally {
      // Always dispose the agent after execution
      agent.dispose();
    }
  };
}
