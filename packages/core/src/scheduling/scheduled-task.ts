/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Watch trigger configuration for event-driven schedule execution.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 * Defines a file watcher that can immediately trigger a schedule
 * when matching files are created or modified, without waiting for cron.
 *
 * @example
 * ```yaml
 * watch:
 *   - path: "workspace/chats/*.json"
 *     filter: '.status == "pending"'
 *     debounce: 5000
 * ```
 */
export interface WatchTrigger {
  /**
   * Glob pattern for files to watch.
   * Supports `*` wildcard in filenames (e.g., "workspace/chats/*.json").
   * Path is resolved relative to the workspace directory.
   */
  path: string;
  /**
   * Optional JSON field filter expression.
   * Checked against the file content when a matching file event occurs.
   * Only triggers if the filter condition is met.
   * Format: `.fieldName == "value"` (simple equality check on top-level JSON fields).
   */
  filter?: string;
  /**
   * Debounce interval in milliseconds.
   * Multiple file events within this window are coalesced into a single trigger.
   * Default: 5000 (5 seconds).
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
   * Event-driven watch triggers.
   * When specified, file changes matching these patterns will immediately
   * trigger the schedule, bypassing the cron interval.
   * Cron still serves as a fallback/safety net.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  watch?: WatchTrigger[];
}
