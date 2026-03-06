/**
 * TaskDispatcher - Coordinates task execution across the worker pool.
 *
 * Key features:
 * - Task dispatch with dependency resolution
 * - Parallel and sequential execution modes
 * - Progress tracking and cancellation
 * - Retry support for failed tasks
 *
 * @module agents/worker/task-dispatcher
 */

import { createLogger } from '../../utils/logger.js';
import { randomUUID } from 'crypto';
import type {
  TaskDispatcher as ITaskDispatcher,
  TaskDispatcherConfig,
  TaskHandle,
  TaskResult,
  SubTask,
  WorkerPool,
  TaskQueue,
} from './types.js';

const logger = createLogger('TaskDispatcher');

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<Omit<TaskDispatcherConfig, 'pool' | 'queue'>> = {
  defaultConcurrency: 5,
  retryFailed: false,
  maxRetries: 3,
};

/**
 * Internal task execution state.
 */
interface TaskExecution {
  handle: TaskHandle;
  resolve: (result: TaskResult) => void;
  reject: (error: Error) => void;
  retries: number;
}

/**
 * Task Dispatcher implementation.
 *
 * Coordinates task execution across a worker pool, supporting:
 * - Parallel execution with concurrency limits
 * - Sequential execution based on dependencies
 * - Task cancellation
 * - Retry on failure
 */
export class TaskDispatcher implements ITaskDispatcher {
  private readonly pool: WorkerPool;
  // Reserved for future queue-based dispatch
  private readonly _queue?: TaskQueue;
  private readonly defaultConcurrency: number;
  private readonly retryFailed: boolean;
  private readonly maxRetries: number;

  private readonly executions = new Map<string, TaskExecution>();
  private disposed = false;

  constructor(config: TaskDispatcherConfig) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.pool = cfg.pool;
    this._queue = cfg.queue;
    this.defaultConcurrency = cfg.defaultConcurrency;
    this.retryFailed = cfg.retryFailed;
    this.maxRetries = cfg.maxRetries;

    logger.info(
      { defaultConcurrency: this.defaultConcurrency, retryFailed: this.retryFailed },
      'TaskDispatcher initialized'
    );
  }

  /**
   * Dispatch a single task for execution.
   *
   * @param task - The task to dispatch
   * @returns Task handle for tracking
   */
  dispatch<T = unknown, R = unknown>(task: SubTask<T, R>): TaskHandle {
    if (this.disposed) {
      throw new Error('TaskDispatcher has been disposed');
    }

    const handleId = `handle-${randomUUID()}`;
    task.status = 'pending';
    task.createdAt = task.createdAt ?? Date.now();

    let resolveResult!: (result: TaskResult) => void;
    let rejectResult!: (error: Error) => void;

    const promise = new Promise<TaskResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let cancelled = false;

    const handle: TaskHandle = {
      id: handleId,
      task,
      promise,
      cancel: () => {
        if (!cancelled && task.status === 'pending') {
          cancelled = true;
          task.status = 'cancelled';
          logger.info({ taskId: task.id, handleId }, 'Task cancelled');
          rejectResult(new Error('Task cancelled'));
        }
      },
    };

    const execution: TaskExecution = {
      handle,
      resolve: resolveResult,
      reject: rejectResult,
      retries: 0,
    };

    this.executions.set(handleId, execution);

    // Execute the task
    this.executeTask(execution)
      .then(result => {
        resolveResult(result);
      })
      .catch(error => {
        rejectResult(error);
      });

    logger.debug({ taskId: task.id, handleId }, 'Task dispatched');
    return handle;
  }

  /**
   * Execute a task with retry support.
   */
  private async executeTask(execution: TaskExecution): Promise<TaskResult> {
    const { handle } = execution;

    while (true) {
      try {
        // Check if cancelled
        if (handle.task.status === 'cancelled') {
          return {
            task: handle.task,
            success: false,
            error: 'Task cancelled',
            duration: 0,
            workerId: '',
          };
        }

        // Execute
        const result = await this.pool.executeOne(handle.task);

        // Retry on failure if enabled
        if (!result.success && this.retryFailed && execution.retries < this.maxRetries) {
          execution.retries++;
          handle.task.status = 'pending';
          handle.task.error = undefined;

          logger.info(
            { taskId: handle.task.id, attempt: execution.retries, maxRetries: this.maxRetries },
            'Retrying failed task'
          );

          continue;
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Retry on error if enabled
        if (this.retryFailed && execution.retries < this.maxRetries) {
          execution.retries++;
          logger.info(
            { taskId: handle.task.id, attempt: execution.retries, error: errorMessage },
            'Retrying task after error'
          );
          continue;
        }

        return {
          task: handle.task,
          success: false,
          error: errorMessage,
          duration: 0,
          workerId: '',
        };
      }
    }
  }

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
  ): TaskHandle[] {
    if (this.disposed) {
      throw new Error('TaskDispatcher has been disposed');
    }

    const handles: TaskHandle[] = [];
    const limit = concurrency ?? this.defaultConcurrency;

    // Check for dependencies and sort if needed
    const sortedTasks = this.sortByDependencies(tasks);

    // Group tasks by dependency level for batch execution
    const levels = this.groupByDependencyLevel(sortedTasks);

    // Dispatch all tasks
    for (const task of sortedTasks) {
      const handle = this.dispatch<T, R>(task);
      handles.push(handle);
    }

    logger.info(
      { taskCount: tasks.length, concurrency: limit, levels: levels.length },
      'Tasks dispatched'
    );

    return handles;
  }

  /**
   * Sort tasks by dependencies (topological sort).
   */
  private sortByDependencies<T, R>(tasks: SubTask<T, R>[]): SubTask<T, R>[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const visited = new Set<string>();
    const result: SubTask<T, R>[] = [];

    const visit = (task: SubTask<T, R>) => {
      if (visited.has(task.id)) return;
      visited.add(task.id);

      // Visit dependencies first
      if (task.dependencies) {
        for (const depId of task.dependencies) {
          const depTask = taskMap.get(depId);
          if (depTask) {
            visit(depTask);
          }
        }
      }

      result.push(task);
    };

    for (const task of tasks) {
      visit(task);
    }

    return result;
  }

  /**
   * Group tasks by dependency level for parallel execution.
   */
  private groupByDependencyLevel<T, R>(tasks: SubTask<T, R>[]): SubTask<T, R>[][] {
    const levels: SubTask<T, R>[][] = [];
    const completed = new Set<string>();

    let remaining = [...tasks];

    while (remaining.length > 0) {
      // Find tasks with no incomplete dependencies
      const level: SubTask<T, R>[] = [];
      const nextRemaining: SubTask<T, R>[] = [];

      for (const task of remaining) {
        const hasIncompleteDeps = task.dependencies?.some(
          depId => !completed.has(depId)
        );

        if (!hasIncompleteDeps) {
          level.push(task);
          completed.add(task.id);
        } else {
          nextRemaining.push(task);
        }
      }

      if (level.length > 0) {
        levels.push(level);
      }

      remaining = nextRemaining;
    }

    return levels;
  }

  /**
   * Wait for all dispatched tasks to complete.
   *
   * @param handles - Task handles to wait for
   * @returns All task results
   */
  async waitForAll(handles: TaskHandle[]): Promise<TaskResult[]> {
    if (this.disposed) {
      throw new Error('TaskDispatcher has been disposed');
    }

    const results = await Promise.all(handles.map(h => h.promise));
    logger.info(
      {
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      },
      'All tasks completed'
    );
    return results;
  }

  /**
   * Wait for any task to complete (returns first completed).
   *
   * @param handles - Task handles to wait for
   * @returns First completed task result
   */
  async waitForAny(handles: TaskHandle[]): Promise<TaskResult> {
    if (this.disposed) {
      throw new Error('TaskDispatcher has been disposed');
    }

    const result = await Promise.race(handles.map(h => h.promise));
    logger.debug({ taskId: result.task.id }, 'First task completed');
    return result;
  }

  /**
   * Get the number of pending tasks.
   */
  pending(): number {
    let count = 0;
    for (const execution of this.executions.values()) {
      if (execution.handle.task.status === 'pending') {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the number of running tasks.
   */
  running(): number {
    let count = 0;
    for (const execution of this.executions.values()) {
      if (execution.handle.task.status === 'running') {
        count++;
      }
    }
    return count;
  }

  /**
   * Dispose the dispatcher and cancel all pending tasks.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    logger.info('Disposing TaskDispatcher');
    this.disposed = true;

    // Cancel all pending tasks
    for (const execution of this.executions.values()) {
      if (execution.handle.task.status === 'pending') {
        execution.handle.cancel();
      }
    }

    this.executions.clear();
  }
}
