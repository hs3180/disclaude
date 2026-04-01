/**
 * Schedule Executor Factory - Creates TaskExecutor for scheduled task execution.
 *
 * Issue #1382: Unified executor implementation for both Primary Node and Worker Node.
 * Issue #1315: Per-task SOUL.md personality injection.
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
 * @param systemPromptAppend - Optional soul content for this task (Issue #1315)
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
 * Load per-task SOUL.md content.
 *
 * If a soul path is provided, loads the file and returns its content.
 * Returns undefined if the path is not provided or the file cannot be loaded.
 *
 * @param soulPath - Optional path to a SOUL.md file
 * @returns Soul content string, or undefined
 */
async function loadPerTaskSoul(soulPath?: string): Promise<string | undefined> {
  if (!soulPath) {
    return undefined;
  }

  try {
    const loader = new SoulLoader(soulPath);
    const result = await loader.load();

    if (result) {
      logger.info(
        { soulPath, sizeBytes: result.sizeBytes },
        'Loaded per-task SOUL.md for scheduled task',
      );
      return result.content;
    }

    logger.warn({ soulPath }, 'Per-task SOUL.md could not be loaded, using default personality');
    return undefined;
  } catch (error) {
    logger.error({ err: error, soulPath }, 'Failed to load per-task SOUL.md');
    return undefined;
  }
}

/**
 * Create a TaskExecutor for scheduled task execution.
 *
 * This factory function creates an executor that:
 * 1. Loads per-task SOUL.md if configured (Issue #1315)
 * 2. Creates a short-lived agent using the provided factory
 * 3. Executes the task via agent.executeOnce()
 * 4. Disposes the agent after execution (success or failure)
 *
 * Issue #1382: This enables both Primary Node and Worker Node to use
 * the same executor logic, just with different agent factories.
 * Issue #1315: Per-task SOUL.md personality injection.
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

  return async (chatId: string, prompt: string, userId?: string, model?: string): Promise<void> => {
    // Create a short-lived agent for this execution
    // Issue #1338: Pass model override for per-task model selection
    // Issue #1315: Pass systemPromptAppend for per-task personality
    const agent = agentFactory(chatId, callbacks, model);

    try {
      await agent.executeOnce(chatId, prompt, undefined, userId); // messageId is always undefined for scheduled tasks
    } finally {
      // Always dispose the agent after execution
      agent.dispose();
    }
  };
}

/**
 * Create a TaskExecutor that supports per-task SOUL.md loading.
 *
 * This variant of createScheduleExecutor loads the SOUL.md file specified
 * in the scheduled task's `soul` field and passes its content to the
 * agent factory as `systemPromptAppend`.
 *
 * The soul content overrides the global soul configuration for this task.
 *
 * @param options - Executor options including agent factory and callbacks
 * @returns A TaskExecutor function that supports per-task soul loading
 *
 * @example
 * ```typescript
 * const executor = createScheduleExecutorWithSoul({
 *   agentFactory: (chatId, callbacks, model, systemPromptAppend) => {
 *     return AgentFactory.createScheduleAgent(chatId, callbacks, {
 *       model,
 *       systemPromptAppend,
 *     });
 *   },
 *   callbacks: { sendMessage: async (chatId, msg) => { ... } },
 * });
 * ```
 */
export function createScheduleExecutorWithSoul(options: ScheduleExecutorOptions): TaskExecutor {
  const { agentFactory, callbacks } = options;

  return async (chatId: string, prompt: string, userId?: string, model?: string, soul?: string): Promise<void> => {
    // Issue #1315: Load per-task SOUL.md if configured
    const soulContent = await loadPerTaskSoul(soul);

    // Create a short-lived agent with per-task soul
    const agent = agentFactory(chatId, callbacks, model, soulContent);

    try {
      await agent.executeOnce(chatId, prompt, undefined, userId);
    } finally {
      agent.dispose();
    }
  };
}
