/**
 * Worker Agent Type Definitions - Master-Workers Collaboration Pattern.
 *
 * This module defines the core interfaces for the Master-Workers architecture
 * as described in Issue #897:
 *
 * ```
 *                     ┌─────────────────┐
 *                     │   User Input    │
 *                     └────────┬────────┘
 *                              │
 *                              ▼
 *                     ┌─────────────────┐
 *                     │  Master Agent   │
 *                     │    (Pilot)      │
 *                     └────────┬────────┘
 *                              │
 *               ┌──────────────┼──────────────┐
 *               │              │              │
 *               ▼              ▼              ▼
 *         ┌──────────┐  ┌──────────┐  ┌──────────┐
 *         │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
 *         │ (Agent)  │  │ (Agent)  │  │ (Agent)  │
 *         └──────────┘  └──────────┘  └──────────┘
 *               │              │              │
 *               └──────────────┼──────────────┘
 *                              │
 *                              ▼
 *                     ┌─────────────────┐
 *                     │  Aggregated     │
 *                     │    Result       │
 *                     └─────────────────┘
 * ```
 *
 * @module agents/worker/types
 */

import type { Disposable } from '../types.js';
import type { AgentMessage } from '../../types/agent.js';

// ============================================================================
// Task Types
// ============================================================================

/**
 * Status of a subtask.
 */
export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Priority level for tasks.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Represents a subtask to be executed by a worker.
 */
export interface SubTask<T = unknown, R = unknown> {
  /** Unique identifier for this subtask */
  id: string;
  /** Task description or input data */
  input: T;
  /** Task priority for scheduling */
  priority?: TaskPriority;
  /** IDs of tasks that must complete before this task can start */
  dependencies?: string[];
  /** Optional metadata for context */
  metadata?: Record<string, unknown>;
  /** Current status of the task */
  status?: SubTaskStatus;
  /** Result of the task (when completed) */
  result?: R;
  /** Error message (when failed) */
  error?: string;
  /** Timestamp when task was created */
  createdAt?: number;
  /** Timestamp when task started */
  startedAt?: number;
  /** Timestamp when task completed */
  completedAt?: number;
}

/**
 * Handle for tracking a dispatched task.
 */
export interface TaskHandle {
  /** Unique identifier for this task execution */
  id: string;
  /** The original subtask */
  task: SubTask;
  /** Promise that resolves with the result */
  promise: Promise<TaskResult>;
  /** Cancel the task if still pending/running */
  cancel: () => void;
}

/**
 * Result of a task execution.
 */
export interface TaskResult<T = unknown> {
  /** The original task */
  task: SubTask;
  /** Whether the task completed successfully */
  success: boolean;
  /** The result data (if successful) */
  result?: T;
  /** Error message (if failed) */
  error?: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** ID of the worker that executed this task */
  workerId: string;
}

// ============================================================================
// Worker Types
// ============================================================================

/**
 * Worker status.
 */
export type WorkerStatus = 'idle' | 'busy' | 'error' | 'disposed';

/**
 * Worker capabilities for task matching.
 */
export interface WorkerCapabilities {
  /** Types of tasks this worker can handle */
  taskTypes?: string[];
  /** Maximum concurrent tasks this worker can handle */
  maxConcurrency?: number;
  /** Custom capability tags */
  tags?: string[];
}

/**
 * Worker statistics for monitoring.
 */
export interface WorkerStats {
  /** Total tasks completed */
  tasksCompleted: number;
  /** Total tasks failed */
  tasksFailed: number;
  /** Average execution time in ms */
  avgExecutionTime: number;
  /** Last activity timestamp */
  lastActivityAt: number | null;
}

/**
 * Worker Agent interface.
 *
 * A Worker is a specialized agent that can execute subtasks independently.
 * Workers are managed by a WorkerPool and can be acquired/released for
 * task execution.
 */
export interface WorkerAgent extends Disposable {
  /** Agent type identifier */
  readonly type: 'worker';

  /** Unique identifier for this worker */
  readonly id: string;

  /** Worker name for logging */
  readonly name: string;

  /** Current status of the worker */
  readonly status: WorkerStatus;

  /** Worker capabilities */
  readonly capabilities?: WorkerCapabilities;

  /**
   * Execute a subtask and return the result.
   *
   * @param task - The subtask to execute
   * @returns AsyncGenerator yielding progress messages and final result
   */
  execute<T = unknown, R = unknown>(task: SubTask<T, R>): AsyncGenerator<AgentMessage, TaskResult<R>, unknown>;

  /**
   * Check if this worker can handle the given task.
   *
   * @param task - The task to check
   * @returns true if the worker can handle this task type
   */
  canHandle(task: SubTask): boolean;

  /**
   * Get worker statistics.
   */
  getStats(): WorkerStats;
}

/**
 * Factory function for creating Worker instances.
 */
export type WorkerFactory = (id: string) => WorkerAgent;

// ============================================================================
// Worker Pool Types
// ============================================================================

/**
 * Configuration for WorkerPool.
 */
export interface WorkerPoolConfig {
  /** Factory function to create workers */
  workerFactory: WorkerFactory;
  /** Maximum number of workers in the pool */
  maxWorkers?: number;
  /** Minimum number of idle workers to maintain */
  minIdleWorkers?: number;
  /** Timeout for acquiring a worker (ms) */
  acquireTimeout?: number;
  /** Enable task queue for waiting when all workers are busy */
  enableQueue?: boolean;
  /** Maximum queue size */
  maxQueueSize?: number;
}

/**
 * Worker Pool interface.
 *
 * Manages a pool of Worker Agents for parallel task execution.
 */
export interface WorkerPool extends Disposable {
  /**
   * Acquire an available worker.
   *
   * @param timeout - Optional timeout in ms
   * @returns A worker instance, or throws on timeout
   */
  acquire(timeout?: number): Promise<WorkerAgent>;

  /**
   * Release a worker back to the pool.
   *
   * @param worker - The worker to release
   */
  release(worker: WorkerAgent): void;

  /**
   * Execute a single task using an available worker.
   *
   * @param task - The task to execute
   * @returns Promise resolving to task result
   */
  executeOne<T = unknown, R = unknown>(task: SubTask<T, R>): Promise<TaskResult<R>>;

  /**
   * Execute multiple tasks in parallel with a concurrency limit.
   *
   * @param tasks - Tasks to execute
   * @param concurrency - Maximum concurrent executions
   * @returns Promise resolving to all task results
   */
  executeAll<T = unknown, R = unknown>(
    tasks: SubTask<T, R>[],
    concurrency?: number
  ): Promise<TaskResult<R>[]>;

  /**
   * Get the number of total workers.
   */
  size(): number;

  /**
   * Get the number of available (idle) workers.
   */
  available(): number;

  /**
   * Get the number of busy workers.
   */
  busy(): number;

  /**
   * Get worker statistics.
   */
  getStats(): Map<string, WorkerStats>;
}

// ============================================================================
// Task Queue Types
// ============================================================================

/**
 * Configuration for TaskQueue.
 */
export interface TaskQueueConfig {
  /** Maximum queue size */
  maxSize?: number;
  /** Enable priority-based ordering */
  enablePriority?: boolean;
}

/**
 * Task Queue interface.
 *
 * Manages a queue of pending tasks with optional priority support.
 */
export interface TaskQueue extends Disposable {
  /**
   * Add a task to the queue.
   *
   * @param task - The task to add
   * @returns true if added successfully, false if queue is full
   */
  enqueue<T = unknown, R = unknown>(task: SubTask<T, R>): boolean;

  /**
   * Get the next task from the queue.
   *
   * @returns The next task, or undefined if queue is empty
   */
  dequeue(): SubTask | undefined;

  /**
   * Peek at the next task without removing it.
   */
  peek(): SubTask | undefined;

  /**
   * Get the number of tasks in the queue.
   */
  size(): number;

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean;

  /**
   * Check if the queue is full.
   */
  isFull(): boolean;

  /**
   * Remove all tasks from the queue.
   */
  clear(): void;

  /**
   * Get tasks by status.
   */
  getByStatus(status: SubTaskStatus): SubTask[];

  /**
   * Cancel a specific task.
   */
  cancel(taskId: string): boolean;
}

// ============================================================================
// Task Dispatcher Types
// ============================================================================

/**
 * Configuration for TaskDispatcher.
 */
export interface TaskDispatcherConfig {
  /** Worker pool to use */
  pool: WorkerPool;
  /** Task queue for pending tasks */
  queue?: TaskQueue;
  /** Default concurrency limit */
  defaultConcurrency?: number;
  /** Retry failed tasks */
  retryFailed?: boolean;
  /** Maximum retry attempts */
  maxRetries?: number;
}

/**
 * Task Dispatcher interface.
 *
 * Coordinates task execution across the worker pool.
 */
export interface TaskDispatcher extends Disposable {
  /**
   * Dispatch a single task for execution.
   *
   * @param task - The task to dispatch
   * @returns Task handle for tracking
   */
  dispatch<T = unknown, R = unknown>(task: SubTask<T, R>): TaskHandle;

  /**
   * Dispatch multiple tasks for parallel execution.
   *
   * @param tasks - Tasks to dispatch
   * @param concurrency - Maximum concurrent executions
   * @returns Task handles for tracking
   */
  dispatchAll<T = unknown, R = unknown>(
    tasks: SubTask<T, R>[],
    concurrency?: number
  ): TaskHandle[];

  /**
   * Wait for all dispatched tasks to complete.
   *
   * @param handles - Task handles to wait for
   * @returns All task results
   */
  waitForAll(handles: TaskHandle[]): Promise<TaskResult[]>;

  /**
   * Wait for any task to complete (returns first completed).
   *
   * @param handles - Task handles to wait for
   * @returns First completed task result
   */
  waitForAny(handles: TaskHandle[]): Promise<TaskResult>;

  /**
   * Get the number of pending tasks.
   */
  pending(): number;

  /**
   * Get the number of running tasks.
   */
  running(): number;
}

// ============================================================================
// Result Aggregator Types
// ============================================================================

/**
 * Aggregation strategy for combining results.
 */
export type AggregationStrategy = 'concat' | 'merge' | 'first' | 'last' | 'custom';

/**
 * Configuration for ResultAggregator.
 */
export interface ResultAggregatorConfig {
  /** Aggregation strategy */
  strategy: AggregationStrategy;
  /** Custom aggregation function (for 'custom' strategy) */
  aggregateFn?: <T>(results: TaskResult<T>[]) => T;
  /** Filter out failed results */
  filterFailed?: boolean;
}

/**
 * Result Aggregator interface.
 *
 * Combines results from multiple task executions.
 */
export interface ResultAggregator {
  /**
   * Aggregate multiple task results into a single result.
   *
   * @param results - Task results to aggregate
   * @returns Aggregated result
   */
  aggregate<T>(results: TaskResult<T>[]): TaskResult<T[]>;

  /**
   * Get successful results only.
   */
  getSuccessful<T>(results: TaskResult<T>[]): TaskResult<T>[];

  /**
   * Get failed results only.
   */
  getFailed<T>(results: TaskResult<T>[]): TaskResult<T>[];

  /**
   * Get summary statistics.
   */
  getSummary(results: TaskResult[]): {
    total: number;
    successful: number;
    failed: number;
    avgDuration: number;
  };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if an object is a WorkerAgent.
 */
export function isWorkerAgent(obj: unknown): obj is WorkerAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: string }).type === 'worker' &&
    'id' in obj &&
    'name' in obj &&
    'execute' in obj &&
    'canHandle' in obj &&
    'dispose' in obj
  );
}

/**
 * Type guard to check if an object is a WorkerPool.
 */
export function isWorkerPool(obj: unknown): obj is WorkerPool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'acquire' in obj &&
    'release' in obj &&
    'executeOne' in obj &&
    'executeAll' in obj &&
    'dispose' in obj
  );
}

/**
 * Type guard to check if an object is a TaskQueue.
 */
export function isTaskQueue(obj: unknown): obj is TaskQueue {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'enqueue' in obj &&
    'dequeue' in obj &&
    'size' in obj &&
    'dispose' in obj
  );
}

/**
 * Type guard to check if an object is a TaskDispatcher.
 */
export function isTaskDispatcher(obj: unknown): obj is TaskDispatcher {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'dispatch' in obj &&
    'dispatchAll' in obj &&
    'waitForAll' in obj &&
    'dispose' in obj
  );
}
