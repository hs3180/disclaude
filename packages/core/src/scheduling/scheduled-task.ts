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
  /**
   * Optional project key for routing to a project-bound ChatAgent.
   *
   * When set, the scheduler routes the task as a NonUserMessage via
   * NonUserMessageRouter instead of creating a short-lived agent.
   * The project-bound agent maintains context between scheduled executions.
   *
   * When not set, the existing short-lived agent path is used (backward compatible).
   *
   * Defined in schedule markdown frontmatter (e.g., `projectKey: "hs3180/disclaude"`).
   *
   * Issue #3333: Scheduler integration with NonUserMessage (Phase 3 of RFC #3329).
   */
  projectKey?: string;
}
