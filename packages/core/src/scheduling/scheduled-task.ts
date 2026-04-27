/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Configuration for a single watch path in event-driven triggers.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */
export interface ScheduleWatchEntry {
  /** File path or glob pattern to watch (relative to workspace or absolute) */
  path: string;
  /** Debounce interval in milliseconds for this watch entry (default: 2000) */
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
   * Event-driven trigger configuration.
   * When specified, file changes in the listed paths will immediately trigger
   * the schedule, bypassing the cron wait. Cron serves as a fallback.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   *
   * Example frontmatter:
   * ```yaml
   * watch:
   *   - path: "workspace/chats/*.json"
   *     debounce: 5000
   *   - path: "workspace/schedules/"
   * ```
   */
  watch?: ScheduleWatchEntry[];
}
