/**
 * Worker Pool Types - Type definitions for Master-Workers multi-agent collaboration.
 *
 * This module implements Phase 1 of Issue #897:
 * - Define Worker Agent interface
 * - Task queue and dispatcher types
 * - Result aggregation types
 *
 * Architecture:
 * ```
 *                    ┌─────────────────┐
 *                    │   User Input    │
 *                    └────────┬────────┘
 *                             │
 *                             ▼
 *                    ┌─────────────────┐
 *                    │  Master Agent   │
 *                    │    (Pilot)      │
 *                    └────────┬────────┘
 *                             │
 *              ┌──────────────┼──────────────┐
 *              │              │              │
 *              ▼              ▼              ▼
 *        ┌──────────┐  ┌──────────┐  ┌──────────┐
 *        │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
 *        │ (Agent)  │  │ (Agent)  │  │ (Agent)  │
 *        └──────────┘  └──────────┘  └──────────┘
 *              │              │              │
 *              └──────────────┼──────────────┘
 *                             │
 *                             ▼
 *                    ┌─────────────────┐
 *                    │  Aggregated     │
 *                    │    Result       │
 *                    └─────────────────┘
 * ```
 *
 * @module agents/worker-pool/types
 */

import type { AgentMessage } from '../../types/agent.js';
import type { Disposable, SkillAgent } from '../types.js';

// ============================================================================
// SubTask Types
// ============================================================================

/**
 * Priority levels for subtasks.
 */
export type TaskPriority = 'high' | 'normal' | 'low';

/**
 * Status of a subtask.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Represents a subtask to be executed by a worker.
 */
export interface SubTask {
  /** Unique identifier for the subtask */
  id: string;
  /** Human-readable description of the task */
  description: string;
  /** The actual input/prompt for the task */
  input: string;
  /** Priority level (affects scheduling order) */
  priority?: TaskPriority;
  /** IDs of tasks that must complete before this one can start */
  dependencies?: string[];
  /** Maximum execution time in milliseconds */
  timeout?: number;
  /** Task metadata for tracking and logging */
  metadata?: Record<string, unknown>;
}

/**
 * Result from executing a subtask.
 */
export interface SubTaskResult {
  /** ID of the completed subtask */
  taskId: string;
  /** Execution status */
  status: TaskStatus;
  /** The result content (if successful) */
  content?: string;
  /** Error message (if failed) */
  error?: string;
  /** Agent messages from execution */
  messages?: AgentMessage[];
  /** Execution time in milliseconds */
  duration?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Handle for tracking a submitted subtask.
 */
export interface TaskHandle {
  /** Task ID */
  taskId: string;
  /** Promise that resolves when the task completes */
  promise: Promise<SubTaskResult>;
  /** Cancel the task (if not yet started) */
  cancel: () => void;
}

// ============================================================================
// Worker Agent Types
// ============================================================================

/**
 * Worker status in the pool.
 */
export type WorkerStatus = 'idle' | 'busy' | 'error' | 'disposed';

/**
 * Configuration for creating a worker agent.
 */
export interface WorkerConfig {
  /** Unique identifier for this worker */
  id: string;
  /** Worker type (e.g., 'general', 'specialized') */
  type?: string;
  /** Maximum concurrent tasks (default: 1) */
  maxConcurrent?: number;
  /** Default timeout for tasks in milliseconds */
  defaultTimeout?: number;
}

/**
 * Statistics for a worker.
 */
export interface WorkerStats {
  /** Worker ID */
  id: string;
  /** Current status */
  status: WorkerStatus;
  /** Number of completed tasks */
  tasksCompleted: number;
  /** Number of failed tasks */
  tasksFailed: number;
  /** Total execution time in milliseconds */
  totalExecutionTime: number;
  /** Average execution time per task */
  averageExecutionTime: number;
}

/**
 * Worker Agent interface.
 *
 * A Worker Agent is a specialized agent that can execute subtasks.
 * It wraps a SkillAgent and provides lifecycle management.
 */
export interface WorkerAgent extends Disposable {
  /** Unique worker identifier */
  readonly id: string;
  /** Worker type */
  readonly type: string;
  /** Current status */
  readonly status: WorkerStatus;
  /** Statistics for this worker */
  readonly stats: WorkerStats;

  /**
   * Execute a subtask.
   *
   * @param task - The subtask to execute
   * @returns Promise resolving to the task result
   */
  execute(task: SubTask): Promise<SubTaskResult>;

  /**
   * Check if the worker is available for new tasks.
   */
  isAvailable(): boolean;
}

/**
 * Factory function type for creating Worker Agents.
 */
export type WorkerFactory = (config: WorkerConfig) => WorkerAgent;

// ============================================================================
// Worker Pool Types
// ============================================================================

/**
 * Configuration for the Worker Pool.
 */
export interface WorkerPoolConfig {
  /** Maximum number of workers in the pool */
  maxWorkers: number;
  /** Minimum number of idle workers to maintain */
  minIdleWorkers?: number;
  /** Factory function for creating workers */
  workerFactory: WorkerFactory;
  /** Default timeout for tasks in milliseconds */
  defaultTimeout?: number;
  /** Maximum time a worker can be idle before being disposed (ms) */
  idleTimeout?: number;
}

/**
 * Statistics for the worker pool.
 */
export interface WorkerPoolStats {
  /** Total number of workers */
  totalWorkers: number;
  /** Number of idle workers */
  idleWorkers: number;
  /** Number of busy workers */
  busyWorkers: number;
  /** Number of pending tasks in queue */
  pendingTasks: number;
  /** Total completed tasks */
  totalCompleted: number;
  /** Total failed tasks */
  totalFailed: number;
}

/**
 * Worker Pool interface.
 *
 * Manages a pool of worker agents for parallel task execution.
 */
export interface WorkerPool extends Disposable {
  /** Pool statistics */
  readonly stats: WorkerPoolStats;

  /**
   * Acquire an available worker.
   *
   * @returns A worker agent, or undefined if none available
   */
  acquire(): WorkerAgent | undefined;

  /**
   * Release a worker back to the pool.
   *
   * @param worker - The worker to release
   */
  release(worker: WorkerAgent): void;

  /**
   * Execute a batch of tasks in parallel.
   *
   * @param tasks - Tasks to execute
   * @param options - Execution options
   * @returns Promise resolving to all task results
   */
  executeAll(
    tasks: SubTask[],
    options?: { maxParallel?: number }
  ): Promise<SubTaskResult[]>;

  /**
   * Get a worker by ID.
   *
   * @param id - Worker ID
   * @returns The worker, or undefined if not found
   */
  getWorker(id: string): WorkerAgent | undefined;

  /**
   * Get all workers.
   *
   * @returns Array of all workers
   */
  getWorkers(): WorkerAgent[];
}

// ============================================================================
// Task Dispatcher Types
// ============================================================================

/**
 * Configuration for the Task Dispatcher.
 */
export interface TaskDispatcherConfig {
  /** The worker pool to use */
  workerPool: WorkerPool;
  /** Maximum parallel tasks (default: pool maxWorkers) */
  maxParallel?: number;
  /** Default task timeout in milliseconds */
  defaultTimeout?: number;
  /** Retry count for failed tasks */
  retryCount?: number;
  /** Retry delay in milliseconds */
  retryDelay?: number;
}

/**
 * Task Dispatcher interface.
 *
 * Handles task queue management and dispatches tasks to workers.
 */
export interface TaskDispatcher extends Disposable {
  /**
   * Submit a task for execution.
   *
   * @param task - The task to submit
   * @returns A handle for tracking the task
   */
  submit(task: SubTask): TaskHandle;

  /**
   * Submit multiple tasks for execution.
   *
   * @param tasks - Tasks to submit
   * @returns Handles for tracking the tasks
   */
  submitAll(tasks: SubTask[]): TaskHandle[];

  /**
   * Wait for all submitted tasks to complete.
   *
   * @returns Promise resolving to all task results
   */
  waitForAll(): Promise<SubTaskResult[]>;

  /**
   * Get pending task count.
   */
  getPendingCount(): number;

  /**
   * Cancel all pending tasks.
   */
  cancelAll(): void;
}

// ============================================================================
// Result Aggregation Types
// ============================================================================

/**
 * Strategy for aggregating results.
 */
export type AggregationStrategy =
  | 'concat'      // Concatenate all results
  | 'merge'       // Merge structured results
  | 'best'        // Take the best result (by score)
  | 'vote'        // Majority vote on results
  | 'custom';     // Custom aggregation function

/**
 * Options for result aggregation.
 */
export interface AggregationOptions {
  /** Aggregation strategy */
  strategy: AggregationStrategy;
  /** Custom aggregation function (for 'custom' strategy) */
  customAggregator?: (results: SubTaskResult[]) => string;
  /** Include metadata in result */
  includeMetadata?: boolean;
}

/**
 * Aggregated result from multiple workers.
 */
export interface AggregatedResult {
  /** The aggregated content */
  content: string;
  /** Number of results aggregated */
  resultCount: number;
  /** Individual results */
  results: SubTaskResult[];
  /** Aggregation metadata */
  metadata?: {
    strategy: AggregationStrategy;
    totalDuration: number;
    successCount: number;
    failureCount: number;
  };
}
