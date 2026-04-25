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
 * When specified, the scheduler watches the given file paths and
 * triggers the task immediately on change, without waiting for cron.
 * Cron acts as a fallback for missed events.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * @example
 * ```yaml
 * trigger:
 *   watch:
 *     - "workspace/chats/*.json"
 *   debounce: 5000
 * ```
 */
export interface ScheduleTriggerConfig {
  /** File path(s) or glob(s) to watch for changes */
  watch: string[];
  /** Debounce interval in milliseconds (default: 5000) */
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
   * When specified, the scheduler watches the given file paths and
   * triggers the task immediately on change.
   * Cron acts as a fallback for missed events.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  trigger?: ScheduleTriggerConfig;
}
