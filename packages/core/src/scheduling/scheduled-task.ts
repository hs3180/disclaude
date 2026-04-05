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
   * Optional directory path to watch for event-driven triggering.
   * When files in this directory change, the schedule is triggered immediately
   * (in addition to its regular cron schedule).
   *
   * Path is relative to the workspace root directory.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   *
   * Example frontmatter: `watch: "workspace/chats"`
   */
  watch?: string;
  /**
   * Debounce interval in milliseconds for watch-triggered events.
   * Multiple file changes within this window are coalesced into a single trigger.
   * Default: 5000ms (5 seconds).
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   *
   * Example frontmatter: `watchDebounce: 3000`
   */
  watchDebounce?: number;
}
