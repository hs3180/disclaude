/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Configuration for event-driven file watching trigger.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 * When declared in schedule frontmatter, the scheduler will watch the
 * specified directory for file changes and trigger execution immediately,
 * rather than waiting for the next cron tick.
 *
 * Example frontmatter:
 * ```yaml
 * watch:
 *   - path: "workspace/chats"
 *     pattern: "*.json"
 *     debounce: 5000
 * ```
 */
export interface WatchConfig {
  /** Directory to watch (relative to workspace root or absolute path) */
  path: string;
  /**
   * Glob pattern to filter watched files (default: "*").
   * Only files matching this pattern will trigger execution.
   */
  pattern?: string;
  /**
   * Debounce interval in milliseconds (default: 5000).
   * Multiple file changes within this window are coalesced into a single trigger.
   */
  debounce?: number;
}

/**
 * Scheduled task definition.
 */
export interface ScheduledTask {
  /** Unique task ID */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Cron expression (e.g., "0 9 * * *" for daily at 9am) */
  cron: string;
  /** Prompt to execute when task triggers */
  prompt: string;
  /** Chat ID where task was created (scope) */
  chatId: string;
  /** User ID who created the task */
  createdBy?: string;
  /** Whether task is enabled */
  enabled: boolean;
  /** Whether to block concurrent executions (skip if previous still running) */
  blocking?: boolean;
  /** Cooldown period in milliseconds (prevents re-execution for this duration after execution) */
  cooldownPeriod?: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last execution timestamp (read from file, for display purposes only) */
  lastExecutedAt?: string;
  /**
   * Optional model override for this task.
   * When set, the schedule agent will use this model instead of the global default.
   * Defined in schedule markdown frontmatter (e.g., `model: "claude-sonnet-4-20250514"`).
   *
   * Issue #1338: Smart model selection per task scenario.
   */
  model?: string;
  /**
   * Optional event-driven file watch triggers.
   * When set, the scheduler will watch the specified paths and trigger
   * execution immediately upon file changes, in addition to cron-based triggers.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  watch?: WatchConfig[];
}
