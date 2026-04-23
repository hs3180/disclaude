/**
 * Subagent Type Definitions - Types for subagent management.
 *
 * Extracted from subagent-manager.ts as part of #2345 Phase 4.
 *
 * @module agents/subagent-types
 */

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
