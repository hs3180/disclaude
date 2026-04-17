/**
 * Type definitions for SubagentManager.
 *
 * Extracted from subagent-manager.ts to keep file sizes under 300 lines.
 *
 * @module agents/subagent-manager-types
 */

import { createLogger, type ChatAgent } from '@disclaude/core';
import type { ChatAgentCallbacks } from './chat-agent/index.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Type of subagent to spawn.
 *
 * Issue #1501: 'skill' type removed. Skills are now handled via
 * ChatAgent.executeOnce() or .md-defined subagents.
 */
export type SubagentType = 'schedule' | 'task';

/**
 * Isolation mode for subagent execution.
 */
export type IsolationMode = 'worktree' | 'none';

/**
 * Status of a subagent.
 */
export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Options for spawning a subagent.
 *
 * @example
 * ```typescript
 * const options: SubagentOptions = {
 *   type: 'task',
 *   name: 'issue-solver',
 *   prompt: 'Fix issue #123',
 *   chatId: 'chat-123',
 *   callbacks: {
 *     sendMessage: async (chatId, text) => { ... },
 *   },
 *   timeout: 60000,
 *   isolation: 'none',
 * };
 * ```
 */
export interface SubagentOptions {
  /** Type of subagent to spawn */
  type: SubagentType;
  /** Name/identifier for the subagent */
  name: string;
  /** Prompt/task for the subagent to execute */
  prompt: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Callbacks for sending messages */
  callbacks: ChatAgentCallbacks;
  /** Optional cron expression for scheduled execution (only for type='schedule') */
  schedule?: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
  /** Isolation mode (default: 'none') */
  isolation?: IsolationMode;
  /** Optional progress callback */
  onProgress?: (message: string) => void;
  /** Optional sender OpenId for scheduled tasks */
  senderOpenId?: string;
}

/**
 * Handle to a spawned subagent.
 *
 * Provides status tracking and control over the subagent lifecycle.
 */
export interface SubagentHandle {
  /** Unique subagent ID */
  id: string;
  /** Subagent type */
  type: SubagentType;
  /** Subagent name */
  name: string;
  /** Target chat ID */
  chatId: string;
  /** Current status */
  status: SubagentStatus;
  /** Process ID (if running in separate process) */
  pid?: number;
  /** Start time */
  startedAt: Date;
  /** Completion time (if completed) */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
  /** Output from the subagent */
  output?: string;
  /** Cron schedule (if scheduled) */
  schedule?: string;
  /** Isolation mode used */
  isolation: IsolationMode;
}

/**
 * Callback for subagent status changes.
 */
export type SubagentStatusCallback = (handle: SubagentHandle) => void;

// ============================================================================
// Agent Execution Helper
// ============================================================================

const logger = createLogger('SubagentManager');

/**
 * Execute an in-memory agent and update the handle with the result.
 *
 * This consolidates the common logic between schedule and task agent spawning,
 * which are structurally identical except for log messages.
 *
 * @param agent - The created ChatAgent instance
 * @param handle - The subagent handle to update
 * @param options - The spawn options
 * @param label - Label for log messages (e.g., 'Schedule subagent', 'Task subagent')
 * @param onStatusChange - Callback to notify status changes
 * @param onAgentTracked - Called when agent is stored for tracking
 * @param onAgentDone - Called when agent execution completes (for cleanup)
 */
export async function executeInMemoryAgent(
  agent: ChatAgent,
  handle: SubagentHandle,
  options: SubagentOptions,
  label: string,
  onStatusChange: (handle: SubagentHandle) => void,
  onAgentTracked: (agent: ChatAgent) => void,
  onAgentDone: () => void,
): Promise<void> {
  onAgentTracked(agent);
  handle.status = 'running';

  logger.info({ subagentId: handle.id, name: options.name }, `${label} started`);
  onStatusChange(handle);

  // Execute task
  try {
    await agent.executeOnce(
      options.chatId,
      options.prompt,
      undefined,
      options.senderOpenId
    );

    handle.status = 'completed';
    handle.completedAt = new Date();
    logger.info({ subagentId: handle.id }, `${label} completed`);
  } catch (error) {
    handle.status = 'failed';
    handle.error = error instanceof Error ? error.message : String(error);
    handle.completedAt = new Date();
    logger.error({ err: error, subagentId: handle.id }, `${label} failed`);
  }

  onStatusChange(handle);

  // Cleanup
  try {
    agent.dispose();
  } catch (err) {
    logger.error({ err, subagentId: handle.id }, `Error disposing ${label.toLowerCase()}`);
  }
  onAgentDone();
}

/** Re-export logger for use by subagent-manager.ts */
export { logger };
