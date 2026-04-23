/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Event-driven trigger configuration for a scheduled task.
 *
 * Issue #1953: Allows schedules to be triggered by file system events
 * in addition to (or instead of) cron expressions.
 *
 * When configured, the EventTriggerManager watches the specified directory
 * for file changes and immediately triggers the schedule execution.
 * The cron expression serves as a fallback for missed events.
 *
 * @example
 * In schedule frontmatter:
 * ```yaml
 * triggerWatch: "workspace/chats/"
 * triggerDebounce: 5000
 * ```
 */
export interface TriggerConfig {
  /**
   * Directory path to watch for file system events.
   * Relative to the workspace root directory.
   *
   * When any file is created or modified in this directory,
   * the schedule is triggered for immediate execution.
   */
  watch: string;
  /**
   * Debounce interval in milliseconds.
   * Multiple file events within this window are coalesced into a single trigger.
   * Default: 5000 (5 seconds)
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
   * Optional event-driven trigger configuration.
   * When set, file system events in the watched directory will trigger
   * the schedule in addition to the cron expression.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  trigger?: TriggerConfig;
}
