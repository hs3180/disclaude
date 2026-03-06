/**
 * TaskDispatcher - Dispatches tasks to workers with queue management.
 *
 * Implements Phase 1 of Issue #897: Task queue and dispatcher.
 *
 * Features:
 * - Task queue with priority support
 * - Multiple dispatch strategies (FIFO, priority, round-robin)
 * - Dependency resolution between tasks
 * - Retry logic for failed tasks
 * - Event callbacks for task completion
 *
 * @example
 * ```typescript
 * const pool = new WorkerPool({ maxWorkers: 3 });
 * const dispatcher = new TaskDispatcher(pool, {
 *   strategy: 'priority',
 *   onTaskComplete: (result) => console.log(`Task ${result.taskId} completed`),
 * });
 *
 * // Add tasks to the queue
 * dispatcher.enqueue([
 *   { id: '1', prompt: 'Task 1', priority: 'high' },
 *   { id: '2', prompt: 'Task 2', priority: 'low' },
 * ]);
 *
 * // Process all tasks
 * const results = await dispatcher.processAll();
 *
 * // Clean up
 * dispatcher.dispose();
 * pool.dispose();
 * ```
 *
 * @module agents/task-dispatcher
 */

import { WorkerPool } from './worker-pool.js';
import type {
  SubTask,
  TaskResult,
  TaskHandle,
  TaskDispatcherConfig,
  TaskPriority,
  WorkerStatus,
} from './worker-types.js';
import { createLogger } from '../utils/logger.js';

/**
 * Internal task wrapper with additional tracking info.
 */
interface QueuedTask {
  task: SubTask;
  enqueuedAt: number;
  attempts: number;
}

/**
 * Internal config with optional callbacks.
 */
type InternalConfig = {
  strategy: 'fifo' | 'priority' | 'round-robin';
  maxRetries: number;
  onTaskComplete?: (result: TaskResult) => void;
  onWorkerStatusChange?: (workerId: string, status: WorkerStatus) => void;
};

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: InternalConfig = {
  strategy: 'fifo',
  maxRetries: 0,
  onTaskComplete: undefined,
  onWorkerStatusChange: undefined,
};

/**
 * TaskDispatcher manages task queue and dispatches tasks to workers.
 *
 * The dispatcher:
 * - Maintains a queue of pending tasks
 * - Orders tasks based on dispatch strategy
 * - Resolves task dependencies
 * - Dispatches tasks to available workers
 * - Handles retries for failed tasks
 */
export class TaskDispatcher {
  private readonly logger = createLogger('TaskDispatcher');
  private readonly pool: WorkerPool;
  private readonly config: InternalConfig;
  private readonly queue: QueuedTask[] = [];
  private readonly completedResults: Map<string, TaskResult> = new Map();
  private disposed = false;

  constructor(pool: WorkerPool, config: TaskDispatcherConfig = {}) {
    this.pool = pool;
    this.config = {
      strategy: config.strategy ?? DEFAULT_CONFIG.strategy,
      maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      onTaskComplete: config.onTaskComplete,
      onWorkerStatusChange: config.onWorkerStatusChange,
    };

    this.logger.debug({ config: this.config }, 'TaskDispatcher created');
  }

  /**
   * Get the number of pending tasks in the queue.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Get the number of completed tasks.
   */
  get completedCount(): number {
    return this.completedResults.size;
  }

  /**
   * Enqueue one or more tasks for processing.
   *
   * Tasks are added to the queue and will be processed based on
   * the dispatch strategy.
   *
   * @param tasks - Tasks to enqueue
   */
  enqueue(tasks: SubTask[]): void {
    this.ensureNotDisposed();

    for (const task of tasks) {
      const queuedTask: QueuedTask = {
        task: { ...task, status: 'pending' },
        enqueuedAt: Date.now(),
        attempts: 0,
      };
      this.queue.push(queuedTask);
    }

    this.sortQueue();
    this.logger.debug({ count: tasks.length, queueSize: this.queue.length }, 'Tasks enqueued');
  }

  /**
   * Process the next task in the queue.
   *
   * @returns The task result, or undefined if queue is empty
   */
  async processNext(): Promise<TaskResult | undefined> {
    this.ensureNotDisposed();

    // Get next task that can be processed (dependencies resolved)
    const queuedTask = this.getNextReadyTask();
    if (!queuedTask) {
      return undefined;
    }

    queuedTask.task.status = 'running';
    queuedTask.attempts++;

    const result = await this.pool.executeTask(queuedTask.task);

    // Handle retry logic
    if (!result.success && queuedTask.attempts < this.config.maxRetries + 1) {
      this.logger.debug(
        { taskId: queuedTask.task.id, attempt: queuedTask.attempts },
        'Task failed, re-queueing for retry'
      );
      queuedTask.task.status = 'pending';
      this.queue.push(queuedTask);
      this.sortQueue();
      return result;
    }

    // Store result and invoke callback
    queuedTask.task.status = result.success ? 'completed' : 'failed';
    this.completedResults.set(queuedTask.task.id, result);

    if (this.config.onTaskComplete) {
      this.config.onTaskComplete(result);
    }

    return result;
  }

  /**
   * Process all tasks in the queue.
   *
   * Tasks are processed based on the dispatch strategy and
   * available workers.
   *
   * @returns Array of all task results
   */
  async processAll(): Promise<TaskResult[]> {
    this.ensureNotDisposed();

    const results: TaskResult[] = [];

    while (this.queue.length > 0) {
      const result = await this.processNext();
      if (result) {
        results.push(result);
      } else {
        // No ready tasks - might be stuck on dependencies
        const readyTask = this.getNextReadyTask();
        if (!readyTask && this.queue.length > 0) {
          this.logger.warn(
            { pendingTasks: this.queue.map(t => t.task.id) },
            'No tasks ready - possible circular dependency'
          );
          break;
        }
      }
    }

    return results;
  }

  /**
   * Dispatch tasks to workers and return handles for tracking.
   *
   * Unlike processAll, this returns handles immediately and
   * allows tracking individual task progress.
   *
   * @param tasks - Tasks to dispatch
   * @returns Array of task handles
   */
  async dispatch(tasks: SubTask[]): Promise<TaskHandle[]> {
    this.ensureNotDisposed();

    this.enqueue(tasks);
    const handles: TaskHandle[] = [];

    // Process all tasks and create handles
    while (this.queue.length > 0) {
      const queuedTask = this.getNextReadyTask();
      if (!queuedTask) {
        break;
      }

      const worker = await this.pool.acquire();
      if (!worker) {
        // No worker available, wait and retry
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      queuedTask.task.status = 'running';
      queuedTask.attempts++;

      const resultPromise = this.executeWithWorker(queuedTask, worker);

      handles.push({
        taskId: queuedTask.task.id,
        workerId: worker.id,
        result: resultPromise,
      });
    }

    return handles;
  }

  /**
   * Wait for all dispatched tasks to complete.
   *
   * @param handles - Task handles to wait for
   * @returns Array of task results
   */
  waitForAll(handles: TaskHandle[]): Promise<TaskResult[]> {
    return Promise.all(handles.map(h => h.result));
  }

  /**
   * Get a completed task result by ID.
   *
   * @param taskId - The task ID
   * @returns The task result, or undefined if not completed
   */
  getResult(taskId: string): TaskResult | undefined {
    return this.completedResults.get(taskId);
  }

  /**
   * Get all completed task results.
   *
   * @returns Map of task ID to result
   */
  getAllResults(): Map<string, TaskResult> {
    return new Map(this.completedResults);
  }

  /**
   * Clear the task queue (does not affect running tasks).
   */
  clearQueue(): void {
    this.queue.length = 0;
    this.logger.debug('Task queue cleared');
  }

  /**
   * Dispose the dispatcher.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.queue.length = 0;
    this.completedResults.clear();

    this.logger.debug('TaskDispatcher disposed');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Get the next task that is ready to be processed.
   *
   * A task is ready if all its dependencies are completed.
   */
  private getNextReadyTask(): QueuedTask | undefined {
    const index = this.queue.findIndex(qt => this.areDependenciesMet(qt.task));
    if (index === -1) {
      return undefined;
    }

    return this.queue.splice(index, 1)[0];
  }

  /**
   * Check if all dependencies for a task are met.
   */
  private areDependenciesMet(task: SubTask): boolean {
    if (!task.dependencies || task.dependencies.length === 0) {
      return true;
    }

    return task.dependencies.every(depId => {
      const result = this.completedResults.get(depId);
      return result?.success === true;
    });
  }

  /**
   * Sort the queue based on dispatch strategy.
   */
  private sortQueue(): void {
    switch (this.config.strategy) {
      case 'priority':
        this.queue.sort((a, b) => this.getPriorityValue(b.task.priority) - this.getPriorityValue(a.task.priority));
        break;
      case 'round-robin':
        // Round-robin is handled during dispatch, not sorting
        break;
      case 'fifo':
      default:
        // Queue is already FIFO by default (push to end)
        break;
    }
  }

  /**
   * Get numeric value for priority (higher = more important).
   */
  private getPriorityValue(priority?: TaskPriority): number {
    switch (priority) {
      case 'high':
        return 3;
      case 'normal':
        return 2;
      case 'low':
        return 1;
      default:
        return 2; // default to normal
    }
  }

  /**
   * Execute a task with a specific worker.
   */
  private async executeWithWorker(queuedTask: QueuedTask, _worker: { id: string }): Promise<TaskResult> {
    const result = await this.pool.executeTask(queuedTask.task);

    // Handle retry logic
    if (!result.success && queuedTask.attempts < this.config.maxRetries + 1) {
      this.logger.debug(
        { taskId: queuedTask.task.id, attempt: queuedTask.attempts },
        'Task failed, re-queueing for retry'
      );
      queuedTask.task.status = 'pending';
      this.queue.push(queuedTask);
      this.sortQueue();
      return result;
    }

    // Store result and invoke callback
    queuedTask.task.status = result.success ? 'completed' : 'failed';
    this.completedResults.set(queuedTask.task.id, result);

    if (this.config.onTaskComplete) {
      this.config.onTaskComplete(result);
    }

    return result;
  }

  /**
   * Ensure the dispatcher has not been disposed.
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('TaskDispatcher has been disposed');
    }
  }
}
