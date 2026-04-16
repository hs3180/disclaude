/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Watch configuration for event-driven schedule triggering.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 * When declared, the schedule can be triggered by filesystem events
 * in addition to (or instead of) cron-based triggering.
 *
 * The scheduler watches the specified paths and triggers the task
 * when matching files are created or modified.
 *
 * @example
 * ```yaml
 * ---
 * name: "Chats Activation"
 * cron: "0 * * * * *"
 * watch:
 *   paths:
 *     - "workspace/chats"
 *   events: ["create", "change"]
 *   debounce: 5000
 * ---
 * ```
 */
export interface WatchConfig {
  /** Directory or file paths to watch (relative to project root or absolute) */
  paths: string[];
  /** Filesystem events to watch for (default: ["create", "change"]) */
  events?: ('create' | 'change' | 'delete')[];
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
   * Optional watch configuration for event-driven triggering.
   * When set, filesystem events on the specified paths will trigger
   * the task immediately, in addition to cron-based triggering.
   *
   * Issue #1953: Event-driven schedule trigger mechanism.
   */
  watch?: WatchConfig;
}
