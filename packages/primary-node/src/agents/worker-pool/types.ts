/**
 * Worker Pool Types - Type definitions for Master-Workers multi-agent collaboration.
 *
 * Issue #897: Support master-workers multi-agent collaboration pattern.
 * Issue #1041: Re-uses base types from @disclaude/core and extends for worker pool.
 *
 * This module defines the core types for:
 * - Worker Agent interface
 * - Task definitions and scheduling (extends core types)
 * - Result aggregation
 * - Worker Pool management
 *
 * @module agents/worker-pool/types
 */

import {
  type ChatAgentCallbacks,
  type BaseTaskOptions,
  type TaskStatus,
  type TaskPriority,
  type TaskDependency,
} from '@disclaude/core';

// Re-export types from core for backward compatibility
export type { TaskStatus, TaskPriority, TaskDependency };

// ============================================================================
// Task Definitions (extending core types)
// ============================================================================

/**
 * Options for creating a task.
 * Extends BaseTaskOptions with worker-pool-specific fields.
 */
export interface TaskOptions extends BaseTaskOptions {
  /** Human-readable task name */
  name: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Callbacks for sending messages */
  callbacks: ChatAgentCallbacks;
  /** Metadata for task tracking */
  metadata?: Record<string, unknown>;
  /** Sender OpenId for context */
  senderOpenId?: string;
}

/**
 * Result from task execution.
 */
export interface TaskResult {
  /** Task ID */
  taskId: string;
  /** Execution status */
  status: TaskStatus;
  /** Output from the task */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Start time */
  startedAt?: Date;
  /** Completion time */
  completedAt?: Date;
  /** Execution duration in milliseconds */
  duration?: number;
  /** Number of retry attempts used */
  retryCount?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Internal task representation with full tracking.
 */
export interface Task extends TaskOptions {
  /** Current status */
  status: TaskStatus;
  /** Creation time */
  createdAt: Date;
  /** Start time */
  startedAt?: Date;
  /** Completion time */
  completedAt?: Date;
  /** Assigned worker ID */
  workerId?: string;
  /** Number of retries attempted */
  retryCount: number;
  /** Final result */
  result?: TaskResult;
}

// ============================================================================
// Worker Definitions
// ============================================================================

/**
 * Status of a worker in the pool.
 */
export type WorkerStatus =
  | 'idle'       // Available for task assignment
  | 'busy'       // Currently executing a task
  | 'error'      // In error state, needs recovery
  | 'disabled';  // Temporarily disabled

/**
 * Type of worker agent.
 */
export type WorkerType =
  | 'general'    // General-purpose worker for any task
  | 'skill'      // Skill-specific worker
  | 'task';      // Task-specific worker

/**
 * Options for creating a worker.
 */
export interface WorkerOptions {
  /** Unique worker identifier */
  id: string;
  /** Worker type */
  type: WorkerType;
  /** Optional skill name for skill-type workers */
  skillName?: string;
  /** Maximum concurrent tasks (default: 1) */
  maxConcurrent?: number;
  /** Worker-specific timeout override */
  defaultTimeout?: number;
}

/**
 * Statistics for a worker.
 */
export interface WorkerStats {
  /** Total tasks completed */
  tasksCompleted: number;
  /** Total tasks failed */
  tasksFailed: number;
  /** Total execution time in milliseconds */
  totalExecutionTime: number;
  /** Average execution time in milliseconds */
  averageExecutionTime: number;
  /** Last activity time */
  lastActivityAt?: Date;
}

/**
 * Handle to a worker in the pool.
 */
export interface WorkerHandle extends WorkerOptions {
  /** Current status */
  status: WorkerStatus;
  /** Currently assigned task IDs */
  currentTaskIds: string[];
  /** Creation time */
  createdAt: Date;
  /** Worker statistics */
  stats: WorkerStats;
}

// ============================================================================
// Pool Configuration
// ============================================================================

/**
 * Configuration for the worker pool.
 */
export interface WorkerPoolConfig {
  /** Maximum number of workers in the pool (default: 5) */
  maxWorkers?: number;
  /** Minimum number of idle workers to maintain (default: 1) */
  minIdleWorkers?: number;
  /** Default task timeout in milliseconds (default: 300000 = 5 minutes) */
  defaultTimeout?: number;
  /** Maximum retry attempts for failed tasks (default: 2) */
  maxRetries?: number;
  /** Enable task priority scheduling (default: true) */
  enablePriority?: boolean;
  /** Maximum tasks to keep in history (default: 100) */
  maxHistorySize?: number;
  /** Task result retention time in milliseconds (default: 3600000 = 1 hour) */
  resultRetentionTime?: number;
}

/**
 * Options for executing multiple tasks.
 */
export interface ExecuteOptions {
  /** Fail fast - stop on first error (default: false) */
  failFast?: boolean;
  /** Maximum parallel tasks (default: pool maxWorkers) */
  maxParallel?: number;
  /** Timeout for entire operation in milliseconds */
  globalTimeout?: number;
  /** Progress callback */
  onProgress?: (completed: number, total: number) => void;
  /** Task completion callback */
  onTaskComplete?: (result: TaskResult) => void;
}

/**
 * Result from batch execution.
 */
export interface BatchResult {
  /** All task results */
  results: TaskResult[];
  /** Number of successful tasks */
  successCount: number;
  /** Number of failed tasks */
  failedCount: number;
  /** Total execution time in milliseconds */
  totalDuration: number;
  /** Whether all tasks succeeded */
  allSucceeded: boolean;
}

// ============================================================================
// Events and Callbacks
// ============================================================================

/**
 * Event types for worker pool.
 */
export type WorkerPoolEventType =
  | 'worker:created'
  | 'worker:idle'
  | 'worker:busy'
  | 'worker:error'
  | 'worker:disposed'
  | 'task:queued'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'pool:drained'
  | 'pool:full';

/**
 * Event payload for worker pool events.
 */
export interface WorkerPoolEvent {
  /** Event type */
  type: WorkerPoolEventType;
  /** Event timestamp */
  timestamp: Date;
  /** Worker ID (if applicable) */
  workerId?: string;
  /** Task ID (if applicable) */
  taskId?: string;
  /** Additional data */
  data?: unknown;
}

/**
 * Callback for worker pool events.
 */
export type WorkerPoolEventCallback = (event: WorkerPoolEvent) => void;
