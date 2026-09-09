/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * Default timezone for scheduled tasks when not explicitly specified.
 *
 * Issue #3860: Configurable timezone per task.
 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

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
  /**
   * Timezone for cron scheduling (IANA timezone name, e.g., "America/New_York").
   * Defaults to "Asia/Shanghai" when not specified.
   * Can be set in schedule markdown frontmatter (e.g., `timezone: "UTC"`).
   *
   * Issue #3860: Configurable timezone for scheduled tasks.
   */
  timezone?: string;
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
  /**
   * Legacy alias: true means freshSession:true + skipHistory:true; explicit
   * false opts into live-chat reuse unless freshSession is specified. Omitted
   * means an isolated fresh session with a bounded history snapshot (#4812).
   * No form resets the user's existing live agent in the scheduler.
   */
  clearContext?: boolean;
  /** Default true: use an isolated per-execution agent, preserving the user's live session. */
  freshSession?: boolean;
  /** Default false: keep the bounded history snapshot; true suppresses it. Requires freshSession. */
  skipHistory?: boolean;
  /**
   * Timeout in milliseconds for how long the scheduler waits for the task's
   * agent TURN to finish (Issue #4648 widened the #3894 timeout from routing
   * to the whole turn via waitForCompletion).
   *
   * The agent is NOT cancelled when the timeout fires — the scheduler stops
   * waiting and records a neutral timeout outcome (the turn may still finish
   * in the background); genuinely stuck turns are killed separately by the
   * agent pool's busy-turn hard cap (#4577).
   *
   * Defaults to DEFAULT_TASK_TIMEOUT_MS (2 hours) when not specified. Tasks
   * that legitimately run longer (long experiments, multi-step waits) should
   * declare their duration here to avoid premature timeout notices
   * (Issue #4649 review ②).
   */
  timeoutMs?: number;
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
}
