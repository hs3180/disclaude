/**
 * Worker Pool Task Queue - Extends core TaskQueue with worker-pool-specific functionality.
 *
 * Issue #897: Support master-workers multi-agent collaboration pattern.
 * Issue #1041: Uses core TaskQueue and extends for worker pool.
 *
 * Features:
 * - Priority-based scheduling (critical > high > normal > low)
 * - Dependency resolution (sequential and conditional)
 * - Task lifecycle management
 * - History tracking
 *
 * @module agents/worker-pool/task-queue
 */

import { TaskQueue } from '@disclaude/core';
import type { Task, TaskOptions } from './types.js';

/**
 * Worker Pool Task Queue - Extended TaskQueue for worker pool operations.
 *
 * @example
 * ```typescript
 * const queue = new WorkerPoolTaskQueue();
 *
 * // Add tasks
 * queue.enqueue({
 *   id: 'task-1',
 *   name: 'First task',
 *   prompt: 'Do something',
 *   chatId: 'chat-123',
 *   callbacks: { ... },
 *   priority: 'high',
 * });
 *
 * // Get next available task
 * const task = queue.dequeue();
 *
 * // Update task status
 * queue.updateStatus('task-1', 'running');
 * ```
 */
export class WorkerPoolTaskQueue extends TaskQueue<Task> {
  constructor(maxHistorySize: number = 100) {
    super(maxHistorySize);
  }

  /**
   * Enqueue a worker pool task.
   * Overrides base enqueue to handle worker-pool-specific task creation.
   */
  enqueue(options: TaskOptions): Task {
    const task: Task = {
      ...options,
      status: 'pending',
      createdAt: new Date(),
      retryCount: 0,
      priority: options.priority ?? 'normal',
      timeout: options.timeout ?? 300000,
      maxRetries: options.maxRetries ?? 0,
      dependencies: options.dependencies ?? [],
    };

    // Use parent class logic for queue management
    return super.enqueue(options, () => task);
  }

  /**
   * Add multiple tasks to the queue.
   */
  enqueueBatch(optionsList: TaskOptions[]): Task[] {
    return optionsList.map(options => this.enqueue(options));
  }

  /**
   * Get all pending tasks.
   */
  getPending(): Task[] {
    const tasks: Task[] = [];
    for (const [_id, task] of this.tasks) {
      if (task.status === 'pending') {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * Get all running tasks.
   */
  getRunning(): Task[] {
    const tasks: Task[] = [];
    for (const [_id, task] of this.tasks) {
      if (task.status === 'running') {
        tasks.push(task);
      }
    }
    return tasks;
  }
}

// Re-export for backward compatibility
export { WorkerPoolTaskQueue as TaskQueue };
