/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

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
   * File path to watch for event-driven triggering.
   * When set, changes to files matching this path will trigger the schedule immediately,
   * in addition to the regular cron schedule.
   *
   * Path is relative to the workspace root directory.
   * Supports glob-like patterns: `workspace/chats/*.json` watches the `workspace/chats/`
   * directory and triggers on changes to `.json` files.
   *
   * The cron schedule serves as a fallback/redundancy when watch triggers are used.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   *
   * @example
   * ```yaml
   * watch: "workspace/chats/*.json"
   * watchDebounce: 5000
   * ```
   */
  watch?: string;

  /**
   * Debounce interval in milliseconds for watch-triggered execution.
   * Prevents rapid re-triggering when multiple file changes occur in quick succession.
   * Defaults to 1000ms if not specified.
   *
   * Only effective when `watch` is set.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  watchDebounce?: number;
}
