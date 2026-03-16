/**
 * Task Queue Types - Generic type definitions for task queue.
 *
 * These types define the core interfaces for task queue operations,
 * following the single responsibility principle.
 *
 * @module queue/types
 */

/**
 * Status of a task in the queue.
 */
export type TaskStatus =
  | 'pending'    // Waiting to be processed
  | 'running'    // Currently being processed
  | 'completed'  // Successfully completed
  | 'failed'     // Execution failed
  | 'cancelled'; // Cancelled before completion

/**
 * Priority levels for task scheduling.
 * Higher priority tasks are executed first.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Dependency specification for a task.
 */
export interface TaskDependency {
  /** ID of the task this depends on */
  taskId: string;
  /** Type of dependency */
  type: 'sequential' | 'conditional';
  /** Optional condition for conditional dependencies */
  condition?: string;
}

/**
 * Result of a task execution.
 */
export interface TaskResult {
  /** Task ID */
  taskId: string;
  /** Final status */
  status: TaskStatus;
  /** Start time */
  startedAt?: Date;
  /** Completion time */
  completedAt?: Date;
  /** Execution duration in milliseconds */
  duration?: number;
  /** Number of retry attempts used */
  retryCount?: number;
  /** Output from successful execution */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Base options for creating a task.
 * Extended by implementation-specific task options.
 */
export interface BaseTaskOptions {
  /** Unique task identifier */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Task description or prompt */
  prompt: string;
  /** Task priority (default: 'normal') */
  priority?: TaskPriority;
  /** Dependencies on other tasks */
  dependencies?: TaskDependency[];
  /** Timeout in milliseconds (default: 300000) */
  timeout?: number;
  /** Maximum retry attempts (default: 0) */
  maxRetries?: number;
}

/**
 * Internal task representation with full tracking.
 */
export interface Task extends BaseTaskOptions {
  /** Current status */
  status: TaskStatus;
  /** Creation time */
  createdAt: Date;
  /** Start time */
  startedAt?: Date;
  /** Completion time */
  completedAt?: Date;
  /** Assigned worker ID (optional) */
  workerId?: string;
  /** Number of retries attempted */
  retryCount: number;
  /** Final result */
  result?: TaskResult;
}
