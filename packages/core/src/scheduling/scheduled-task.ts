/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * Issue #1953: Added trigger configuration for event-driven execution.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * File watch trigger configuration.
 * When a file matching the pattern changes, the schedule is triggered.
 */
export interface WatchTriggerConfig {
  /** Glob pattern or directory path to watch (e.g., 'workspace/chats/*.json') */
  path: string;
  /** Optional filter expression (e.g., '.status == "pending"') */
  filter?: string;
  /** Debounce interval in milliseconds (default: 5000) */
  debounce?: number;
}

/**
 * Trigger configuration for event-driven schedule execution.
 *
 * Issue #1953: Allows schedules to be triggered by events
 * in addition to (or instead of) cron.
 *
 * When a trigger is configured, the schedule will execute
 * immediately when the specified event fires. Cron continues
 * as a fallback to handle missed events.
 *
 * Example frontmatter:
 * ```yaml
 * trigger:
 *   events:
 *     - chat:pending
 *     - file:created
 *   watch:
 *     - path: workspace/chats/*.json
 *       filter: '.status == "pending"'
 *       debounce: 5000
 *   invocable: true
 * ```
 */
export interface TriggerConfig {
  /** Event names that trigger this schedule */
  events?: string[];
  /** File watch patterns that trigger this schedule */
  watch?: WatchTriggerConfig[];
  /** Whether this schedule can be directly invoked via Scheduler.trigger() */
  invocable?: boolean;
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
   *
   * When set, the schedule can be triggered by events in addition to cron.
   * Cron continues to run as a fallback for reliability.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  trigger?: TriggerConfig;
}
