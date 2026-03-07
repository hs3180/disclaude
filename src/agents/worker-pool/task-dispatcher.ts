/**
 * Task Dispatcher Implementation - Handles task queue and dispatches to workers.
 *
 * This module implements Phase 1 of Issue #897:
 * - Task queue management
 * - Priority-based scheduling
 * - Dependency resolution
 * - Retry logic
 *
 * @module agents/worker-pool/task-dispatcher
 */

import { createLogger } from '../../utils/logger.js';
import type {
  TaskDispatcher as ITaskDispatcher,
  TaskDispatcherConfig,
  SubTask,
  SubTaskResult,
  TaskHandle,
  TaskStatus,
  WorkerPool,
} from './types.js';

const logger = createLogger('TaskDispatcher');

/**
 * Internal task representation with tracking info.
 */
interface InternalTask {
  /** The original subtask */
  subtask: SubTask;
  /** Current status */
  status: TaskStatus;
  /** Resolve function for the promise */
  resolve: (result: SubTaskResult) => void;
  /** Reject function for the promise */
  reject: (error: Error) => void;
  /** Retry count */
  retries: number;
  /** Abort controller for cancellation */
  abortController: AbortController;
}

/**
 * TaskDispatcher - Handles task queue and dispatches tasks to workers.
 *
 * Features:
 * - Priority-based task queue
 * - Dependency resolution between tasks
 * - Retry logic for failed tasks
 * - Task cancellation
 *
 * @example
 * ```typescript
 * const dispatcher = new TaskDispatcher({
 *   workerPool: pool,
 *   maxParallel: 3,
 *   retryCount: 2,
 * });
 *
 * // Submit tasks
 * const handle1 = dispatcher.submit({ id: '1', description: 'Task 1', input: '...' });
 * const handle2 = dispatcher.submit({ id: '2', description: 'Task 2', input: '...' });
 *
 * // Wait for completion
 * const results = await dispatcher.waitForAll();
 *
 * dispatcher.dispose();
 * ```
 */
export class TaskDispatcher implements ITaskDispatcher {
  private readonly config: Required<Omit<TaskDispatcherConfig, 'workerPool'>> & {
    workerPool: WorkerPool;
  };
  private readonly taskQueue: InternalTask[] = [];
  private readonly runningTasks: Map<string, InternalTask> = new Map();
  private readonly completedTasks: Map<string, SubTaskResult> = new Map();
  private disposed = false;
  private processing = false;

  constructor(config: TaskDispatcherConfig) {
    this.config = {
      workerPool: config.workerPool,
      maxParallel: config.maxParallel ?? config.workerPool.stats.totalWorkers,
      defaultTimeout: config.defaultTimeout ?? 60000,
      retryCount: config.retryCount ?? 1,
      retryDelay: config.retryDelay ?? 1000,
    };

    logger.info(
      { maxParallel: this.config.maxParallel, retryCount: this.config.retryCount },
      'TaskDispatcher initialized'
    );
  }

  /**
   * Submit a task for execution.
   *
   * @param task - The task to submit
   * @returns A handle for tracking the task
   */
  submit(task: SubTask): TaskHandle {
    if (this.disposed) {
      throw new Error('TaskDispatcher has been disposed');
    }

    const abortController = new AbortController();

    const internalTask: InternalTask = {
      subtask: task,
      status: 'pending',
      resolve: () => {},
      reject: () => {},
      retries: 0,
      abortController,
    };

    // Create promise for task completion
    const promise = new Promise<SubTaskResult>((resolve, reject) => {
      internalTask.resolve = resolve;
      internalTask.reject = reject;
    });

    // Add to queue
    this.taskQueue.push(internalTask);
    logger.debug({ taskId: task.id }, 'Task submitted to queue');

    // Trigger processing
    this.processQueue();

    return {
      taskId: task.id,
      promise,
      cancel: () => this.cancelTask(task.id),
    };
  }

  /**
   * Submit multiple tasks for execution.
   *
   * @param tasks - Tasks to submit
   * @returns Handles for tracking the tasks
   */
  submitAll(tasks: SubTask[]): TaskHandle[] {
    return tasks.map((task) => this.submit(task));
  }

  /**
   * Wait for all submitted tasks to complete.
   *
   * @returns Promise resolving to all task results
   */
  async waitForAll(): Promise<SubTaskResult[]> {
    // Get all pending and running task promises
    const promises: Promise<SubTaskResult>[] = [];

    for (const task of this.taskQueue) {
      if (task.status === 'pending' || task.status === 'running') {
        promises.push(
          new Promise<SubTaskResult>((resolve, reject) => {
            const originalResolve = task.resolve;
            const originalReject = task.reject;

            task.resolve = (result) => {
              originalResolve(result);
              resolve(result);
            };

            task.reject = (error) => {
              originalReject(error);
              reject(error);
            };
          })
        );
      }
    }

    for (const task of this.runningTasks.values()) {
      promises.push(
        new Promise<SubTaskResult>((resolve, reject) => {
          const originalResolve = task.resolve;
          const originalReject = task.reject;

          task.resolve = (result) => {
            originalResolve(result);
            resolve(result);
          };

          task.reject = (error) => {
            originalReject(error);
            reject(error);
          };
        })
      );
    }

    if (promises.length === 0) {
      return Array.from(this.completedTasks.values());
    }

    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Create error result for rejected promises
      const tasks = [...this.taskQueue, ...this.runningTasks.values()];
      return {
        taskId: tasks[index]?.subtask.id ?? 'unknown',
        status: 'failed' as const,
        error: result.reason?.message ?? 'Unknown error',
      };
    });
  }

  /**
   * Get pending task count.
   */
  getPendingCount(): number {
    return this.taskQueue.filter((t) => t.status === 'pending').length;
  }

  /**
   * Cancel all pending tasks.
   */
  cancelAll(): void {
    for (const task of this.taskQueue) {
      if (task.status === 'pending') {
        task.status = 'cancelled';
        task.abortController.abort();
        task.resolve({
          taskId: task.subtask.id,
          status: 'cancelled',
        });
      }
    }

    // Remove cancelled tasks from queue
    const pendingCount = this.taskQueue.length;
    this.taskQueue.length = 0;
    this.taskQueue.push(
      ...this.taskQueue.filter((t) => t.status !== 'cancelled')
    );

    logger.info({ cancelledCount: pendingCount - this.taskQueue.length }, 'Cancelled pending tasks');
  }

  /**
   * Cancel a specific task.
   */
  private cancelTask(taskId: string): void {
    const task = this.taskQueue.find((t) => t.subtask.id === taskId);
    if (task && task.status === 'pending') {
      task.status = 'cancelled';
      task.abortController.abort();
      task.resolve({
        taskId,
        status: 'cancelled',
      });
      logger.debug({ taskId }, 'Task cancelled');
    }
  }

  /**
   * Process the task queue.
   */
  private processQueue(): void {
    if (this.processing || this.disposed) {
      return;
    }

    this.processing = true;

    // Sort by priority
    this.taskQueue.sort((a, b) => {
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      const aPriority = priorityOrder[a.subtask.priority ?? 'normal'];
      const bPriority = priorityOrder[b.subtask.priority ?? 'normal'];
      return aPriority - bPriority;
    });

    // Process tasks that are ready
    this.processReadyTasks()
      .catch((error) => {
        logger.error({ error }, 'Error processing task queue');
      })
      .finally(() => {
        this.processing = false;
      });
  }

  /**
   * Process tasks that are ready to execute.
   */
  private async processReadyTasks(): Promise<void> {
    while (
      this.runningTasks.size < this.config.maxParallel &&
      this.taskQueue.length > 0
    ) {
      // Find a task that is ready (no pending dependencies)
      const readyTaskIndex = this.taskQueue.findIndex((task) => {
        if (task.status !== 'pending') return false;
        if (task.abortController.signal.aborted) return false;

        // Check dependencies
        const deps = task.subtask.dependencies ?? [];
        return deps.every((depId) => this.completedTasks.has(depId));
      });

      if (readyTaskIndex === -1) {
        // No tasks ready, stop processing
        break;
      }

      const task = this.taskQueue.splice(readyTaskIndex, 1)[0];
      this.executeTask(task).catch((error) => {
        logger.error({ error, taskId: task.subtask.id }, 'Task execution failed');
      });
    }

    // Continue processing if there are still pending tasks
    if (this.taskQueue.some((t) => t.status === 'pending')) {
      // Wait for a running task to complete, then try again
      if (this.runningTasks.size > 0) {
        await Promise.race(
          Array.from(this.runningTasks.values()).map((t) =>
            new Promise<void>((resolve) => {
              const originalResolve = t.resolve;
              t.resolve = (result) => {
                originalResolve(result);
                resolve();
              };
            })
          )
        );
        this.processQueue();
      }
    }
  }

  /**
   * Execute a single task.
   */
  private async executeTask(internalTask: InternalTask): Promise<void> {
    const { subtask } = internalTask;
    internalTask.status = 'running';
    this.runningTasks.set(subtask.id, internalTask);

    logger.debug({ taskId: subtask.id }, 'Starting task execution');

    try {
      // Execute via worker pool
      const results = await this.config.workerPool.executeAll([subtask]);
      const result = results[0];

      if (result.status === 'failed' && internalTask.retries < this.config.retryCount) {
        // Retry the task
        internalTask.retries++;
        internalTask.status = 'pending';
        this.runningTasks.delete(subtask.id);

        logger.info(
          { taskId: subtask.id, retry: internalTask.retries },
          'Retrying failed task'
        );

        await this.sleep(this.config.retryDelay);
        this.taskQueue.unshift(internalTask); // Add to front of queue
        this.processQueue();
        return;
      }

      // Complete the task
      this.completedTasks.set(subtask.id, result);
      this.runningTasks.delete(subtask.id);
      internalTask.status = result.status;
      internalTask.resolve(result);

      logger.debug({ taskId: subtask.id, status: result.status }, 'Task completed');

      // Trigger processing of dependent tasks
      this.processQueue();
    } catch (error) {
      internalTask.status = 'failed';
      this.runningTasks.delete(subtask.id);

      const result: SubTaskResult = {
        taskId: subtask.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };

      this.completedTasks.set(subtask.id, result);
      internalTask.resolve(result);

      logger.error({ error, taskId: subtask.id }, 'Task failed');

      // Continue processing other tasks
      this.processQueue();
    }
  }

  /**
   * Sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Dispose of the dispatcher.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    logger.info('Disposing TaskDispatcher');

    // Cancel all pending tasks
    this.cancelAll();

    // Clear queues
    this.taskQueue.length = 0;
    this.runningTasks.clear();
    this.completedTasks.clear();

    logger.info('TaskDispatcher disposed');
  }
}
