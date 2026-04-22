/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * Issue #1953: Added event-driven trigger configuration.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * A single trigger watch rule.
 * When the specified path changes (file created/modified/deleted),
 * the schedule is immediately triggered (in addition to cron).
 */
export interface TriggerRule {
  /** File system path to watch (relative to workspace dir) */
  path: string;
  /** Optional JMESPath-like filter expression (future use) */
  filter?: string;
  /** Debounce interval in milliseconds (default: 5000) */
  debounceMs?: number;
}

/**
 * Event-driven trigger configuration for a scheduled task.
 * Allows schedules to be triggered immediately when watched files change,
 * in addition to the regular cron schedule.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */
export interface TriggerConfig {
  /** Array of watch rules that trigger this schedule */
  watch: TriggerRule[];
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
   * When set, file system changes matching the watch rules will
   * immediately trigger the schedule (in addition to cron).
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  trigger?: TriggerConfig;
}
