/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * A single watch path configuration.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 * When a file matching the path pattern changes, the schedule is triggered immediately.
 */
export interface WatchPath {
  /** Glob pattern or directory path to watch (relative to workspace) */
  path: string;
  /** Debounce interval in milliseconds (default: 1000) */
  debounceMs?: number;
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
   * Optional file paths to watch for changes.
   * When a file matching any of these patterns changes, the schedule is triggered immediately.
   * Cron continues as a fallback (reduced frequency recommended).
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   *
   * @example
   * ```yaml
   * watch:
   *   - path: "workspace/chats/*.json"
   *     debounceMs: 5000
   * ```
   */
  watch?: WatchPath[];
}
