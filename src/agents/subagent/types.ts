/**
 * Unified Subagent Types - Issue #997
 *
 * Provides unified interfaces for creating and managing subagents.
 * Supports three types: schedule, skill, and task.
 *
 * @module agents/subagent/types
 */

/**
 * Type of subagent.
 */
export type SubagentType = 'schedule' | 'skill' | 'task';

/**
 * Status of a subagent.
 */
export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout';

/**
 * Isolation mode for subagent execution.
 */
export type IsolationMode = 'none' | 'worktree';

/**
 * Options for spawning a subagent.
 */
export interface SubagentOptions {
  /** Type of subagent */
  type: SubagentType;
  /** Human-readable name for the subagent */
  name: string;
  /** Prompt/instruction for the subagent */
  prompt: string;
  /** Chat ID for notifications (optional) */
  chatId?: string;
  /** Isolation mode (default: 'none') */
  isolation?: IsolationMode;
  /** Timeout in milliseconds (optional) */
  timeout?: number;
  /** Skill name (required for type: 'skill') */
  skillName?: string;
  /** Template variables for skill (optional) */
  templateVars?: Record<string, string>;
  /** Schedule expression (required for type: 'schedule') */
  schedule?: string;
  /** Progress callback */
  onProgress?: (message: string) => void;
  /** Working directory override */
  cwd?: string;
}

/**
 * Handle to a spawned subagent.
 */
export interface SubagentHandle {
  /** Unique identifier */
  id: string;
  /** Type of subagent */
  type: SubagentType;
  /** Human-readable name */
  name: string;
  /** Current status */
  status: SubagentStatus;
  /** Process ID (if running in separate process) */
  pid?: number;
  /** Start time */
  startedAt: Date;
  /** Completion time (if completed) */
  completedAt?: Date;
  /** Duration in milliseconds */
  duration?: number;
  /** Error message (if failed) */
  error?: string;
  /** Output from the subagent */
  output?: string;
  /** Worktree path (if isolated) */
  worktreePath?: string;
}

/**
 * Metrics for a subagent execution.
 */
export interface SubagentMetrics {
  /** Total execution time in ms */
  totalDurationMs: number;
  /** Number of iterations (for task agents) */
  iterations?: number;
  /** Number of tool calls */
  toolCalls?: number;
  /** Number of errors */
  errors: number;
  /** Last error message */
  lastError?: string;
  /** Token usage (if available) */
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
}

/**
 * Result of a subagent execution.
 */
export interface SubagentResult {
  /** Whether execution was successful */
  success: boolean;
  /** Output/result from the subagent */
  output?: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution metrics */
  metrics?: SubagentMetrics;
  /** Handle to the subagent */
  handle: SubagentHandle;
}

/**
 * Callbacks for subagent notifications.
 */
export interface SubagentCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** Send a card message (optional) */
  sendCard?: (chatId: string, card: Record<string, unknown>) => Promise<void>;
  /** Send a file (optional) */
  sendFile?: (chatId: string, filePath: string) => Promise<void>;
}

/**
 * Filter options for listing subagents.
 */
export interface SubagentListFilter {
  /** Filter by type */
  type?: SubagentType;
  /** Filter by status */
  status?: SubagentStatus;
  /** Filter by name pattern */
  namePattern?: string | RegExp;
}
