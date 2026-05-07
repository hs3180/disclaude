/**
 * ScheduledTask type definition.
 *
 * Shared type for scheduled task data structure.
 * Used by both ScheduleManager and Scheduler.
 *
 * @module @disclaude/core/scheduling
 */

import type { ModelTier } from '../config/types.js';

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
  /**
   * Timeout in milliseconds for task execution.
   * When set, the task will be forcefully terminated after this duration,
   * preventing indefinitely hung tasks from blocking subsequent executions.
   * Defaults to DEFAULT_TASK_TIMEOUT_MS (30 minutes) when not specified.
   *
   * Issue #3346: Timeout protection for scheduled tasks.
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
  /**
   * Model tier for this task (high/low/multimodal).
   * Resolved to a model name via Config.getModelForTier().
   * Ignored when `model` is explicitly set (explicit model takes highest priority).
   *
   * Defined in schedule markdown frontmatter (e.g., `modelTier: "low"`).
   *
   * Issue #3059: Three-level model configuration.
   */
  modelTier?: ModelTier;
}
