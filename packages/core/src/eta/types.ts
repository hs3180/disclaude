/**
 * ETA Estimation Types - Type definitions for task record management.
 *
 * Defines the data structures for task execution recording and ETA estimation,
 * following the Markdown-based free-form storage approach (Issue #1234 Phase 1).
 *
 * @module eta/types
 */

/**
 * Task type categories for ETA estimation.
 */
export type TaskType = 'bugfix' | 'feature' | 'refactoring' | 'research' | 'test' | 'docs' | 'chore';

/**
 * A single task execution record.
 * Stored as Markdown in `.claude/task-records.md`.
 */
export interface TaskRecord {
  /** Brief description of the task */
  title: string;
  /** Date string in YYYY-MM-DD format */
  date: string;
  /** Task type category */
  type: TaskType;
  /** Estimated time before starting (e.g., "30分钟", "1小时") */
  estimatedTime: string;
  /** Why this estimate was chosen - references to similar past tasks or complexity factors */
  estimationBasis: string;
  /** Actual time taken (e.g., "45分钟") */
  actualTime: string;
  /** Brief review: what went well, what was underestimated, lessons learned */
  review: string;
}

/**
 * Options for TaskRecordManager.
 */
export interface TaskRecordManagerOptions {
  /** Base directory for storing task records (default: process.cwd()) */
  baseDir?: string;
  /** Custom path for task records file (default: `{baseDir}/.claude/task-records.md`) */
  recordsPath?: string;
  /** Custom path for ETA rules file (default: `{baseDir}/.claude/eta-rules.md`) */
  rulesPath?: string;
}

/**
 * Parsed task record with additional metadata from the Markdown file.
 */
export interface ParsedTaskRecord extends TaskRecord {
  /** 1-based line number where this record starts in the file */
  lineNumber: number;
}
