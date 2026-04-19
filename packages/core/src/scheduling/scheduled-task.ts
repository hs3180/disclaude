/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Signal-based trigger configuration.
 *
 * Issue #1953: Event-driven schedule trigger mechanism (Method C — Signal File).
 *
 * When a task has a `trigger` config, Skills can write a signal file
 * to the specified path to immediately trigger the schedule execution,
 * bypassing the normal cron cycle. Cron continues as a fallback.
 *
 * Usage in frontmatter:
 * ```yaml
 * trigger:
 *   signalPath: "workspace/chats/.trigger"
 *   debounce: 5000
 * ```
 *
 * In a Skill, trigger the schedule by:
 * ```bash
 * touch workspace/chats/.trigger
 * ```
 */
export interface SignalTrigger {
  /** File path to watch for signal files (absolute or relative to workspace). */
  signalPath: string;
  /** Debounce interval in milliseconds (default: 1000). Multiple signals within this window are batched. */
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
   * Signal-based trigger configuration (Issue #1953).
   *
   * When set, the Scheduler watches the specified signalPath and
   * triggers this task immediately when a signal file appears.
   * Cron acts as a reduced-frequency fallback.
   */
  trigger?: SignalTrigger;
}
