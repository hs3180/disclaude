/**
 * TaskQueue - Priority-based task queue implementation.
 *
 * Provides a queue for managing pending tasks with:
 * - Priority-based ordering (higher priority tasks processed first)
 * - Status tracking
 * - Task cancellation support
 *
 * @module agents/worker/task-queue
 */

import { createLogger } from '../../utils/logger.js';
import type {
  SubTask,
  SubTaskStatus,
  TaskQueue as ITaskQueue,
  TaskQueueConfig,
  TaskPriority,
} from './types.js';

const logger = createLogger('TaskQueue');

/**
 * Priority values for ordering (higher = processed first).
 */
const PRIORITY_VALUES: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<Omit<TaskQueueConfig, 'enablePriority'>> & { enablePriority: boolean } = {
  maxSize: 1000,
  enablePriority: true,
};

/**
 * Priority-based task queue implementation.
 */
export class TaskQueue implements ITaskQueue {
  private readonly queue: SubTask[] = [];
  private readonly maxSize: number;
  private readonly enablePriority: boolean;
  private readonly tasksById = new Map<string, SubTask>();
  private disposed = false;

  constructor(config?: TaskQueueConfig) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.maxSize = cfg.maxSize;
    this.enablePriority = cfg.enablePriority;
    logger.debug({ maxSize: this.maxSize, enablePriority: this.enablePriority }, 'TaskQueue initialized');
  }

  /**
   * Add a task to the queue.
   *
   * Tasks are inserted in priority order (if enabled).
   *
   * @param task - The task to add
   * @returns true if added successfully, false if queue is full or disposed
   */
  enqueue<T = unknown, R = unknown>(task: SubTask<T, R>): boolean {
    if (this.disposed) {
      logger.warn('Attempted to enqueue to disposed queue');
      return false;
    }

    if (this.queue.length >= this.maxSize) {
      logger.warn({ taskId: task.id, maxSize: this.maxSize }, 'Queue is full, cannot enqueue');
      return false;
    }

    // Set initial status and timestamp
    const taskWithDefaults: SubTask = {
      ...task,
      status: task.status ?? 'pending',
      createdAt: task.createdAt ?? Date.now(),
    };

    // Check for duplicate
    if (this.tasksById.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already exists in queue');
      return false;
    }

    this.tasksById.set(task.id, taskWithDefaults);

    if (this.enablePriority) {
      // Insert in priority order using binary search
      const priority = PRIORITY_VALUES[taskWithDefaults.priority ?? 'normal'];
      let low = 0;
      let high = this.queue.length;

      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const midPriority = PRIORITY_VALUES[this.queue[mid].priority ?? 'normal'];

        if (midPriority >= priority) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }

      this.queue.splice(low, 0, taskWithDefaults);
      logger.debug(
        { taskId: task.id, priority: taskWithDefaults.priority, position: low },
        'Task enqueued with priority'
      );
    } else {
      // Simple FIFO
      this.queue.push(taskWithDefaults);
      logger.debug({ taskId: task.id, position: this.queue.length - 1 }, 'Task enqueued');
    }

    return true;
  }

  /**
   * Get the next task from the queue.
   *
   * Only returns tasks with 'pending' status and no incomplete dependencies.
   *
   * @returns The next task, or undefined if queue is empty
   */
  dequeue(): SubTask | undefined {
    if (this.disposed || this.queue.length === 0) {
      return undefined;
    }

    // Find first task that is pending and has no incomplete dependencies
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];

      if (task.status !== 'pending') {
        continue;
      }

      // Check dependencies
      if (task.dependencies && task.dependencies.length > 0) {
        const hasIncompleteDeps = task.dependencies.some(depId => {
          const depTask = this.tasksById.get(depId);
          return depTask && depTask.status !== 'completed';
        });

        if (hasIncompleteDeps) {
          continue;
        }
      }

      // Remove from queue and map
      this.queue.splice(i, 1);
      this.tasksById.delete(task.id);

      logger.debug({ taskId: task.id }, 'Task dequeued');
      return task;
    }

    return undefined;
  }

  /**
   * Peek at the next task without removing it.
   */
  peek(): SubTask | undefined {
    if (this.disposed || this.queue.length === 0) {
      return undefined;
    }

    // Find first pending task with no incomplete dependencies
    for (const task of this.queue) {
      if (task.status !== 'pending') {
        continue;
      }

      if (task.dependencies && task.dependencies.length > 0) {
        const hasIncompleteDeps = task.dependencies.some(depId => {
          const depTask = this.tasksById.get(depId);
          return depTask && depTask.status !== 'completed';
        });

        if (hasIncompleteDeps) {
          continue;
        }
      }

      return task;
    }

    return undefined;
  }

  /**
   * Get the number of tasks in the queue.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check if the queue is full.
   */
  isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /**
   * Remove all tasks from the queue.
   */
  clear(): void {
    logger.info({ count: this.queue.length }, 'Clearing task queue');
    this.queue.length = 0;
    this.tasksById.clear();
  }

  /**
   * Get tasks by status.
   *
   * @param status - The status to filter by
   * @returns Array of tasks with the given status
   */
  getByStatus(status: SubTaskStatus): SubTask[] {
    return this.queue.filter(task => task.status === status);
  }

  /**
   * Update a task's status.
   *
   * @param taskId - The task ID
   * @param status - The new status
   * @returns true if updated, false if not found
   */
  updateStatus(taskId: string, status: SubTaskStatus): boolean {
    const task = this.tasksById.get(taskId);
    if (task) {
      task.status = status;
      logger.debug({ taskId, status }, 'Task status updated');
      return true;
    }
    return false;
  }

  /**
   * Cancel a specific task.
   *
   * @param taskId - The task ID to cancel
   * @returns true if cancelled, false if not found or already completed
   */
  cancel(taskId: string): boolean {
    const index = this.queue.findIndex(t => t.id === taskId);
    if (index === -1) {
      return false;
    }

    const task = this.queue[index];
    if (task.status === 'completed' || task.status === 'cancelled') {
      return false;
    }

    // Remove from queue
    this.queue.splice(index, 1);
    this.tasksById.delete(taskId);

    logger.info({ taskId }, 'Task cancelled');
    return true;
  }

  /**
   * Get a task by ID.
   *
   * @param taskId - The task ID
   * @returns The task or undefined
   */
  get(taskId: string): SubTask | undefined {
    return this.tasksById.get(taskId);
  }

  /**
   * Dispose of the queue.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    logger.info('Disposing TaskQueue');
    this.disposed = true;
    this.queue.length = 0;
    this.tasksById.clear();
  }
}
