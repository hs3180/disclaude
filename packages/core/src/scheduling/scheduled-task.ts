/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * Issue #1953: Added watch trigger support for event-driven execution.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Watch trigger configuration for event-driven schedule execution.
 *
 * Issue #1953: Allows schedules to be triggered by file system changes
 * in addition to cron-based timing.
 *
 * @example
 * ```yaml
 * watch:
 *   paths:
 *     - "workspace/chats"
 *   debounce: 5000
 * ```
 */
export interface WatchTrigger {
  /** Directory paths to watch for file changes */
  paths: string[];
  /** Debounce interval in milliseconds (default: 1000) */
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
   * Optional watch trigger configuration for event-driven execution.
   * When set, the schedule is triggered immediately when watched paths change.
   * The cron schedule serves as a fallback.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  watch?: WatchTrigger;
}
