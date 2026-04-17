/**
 * Worker Pool Execution - Task submission and batch execution logic.
 *
 * Contains functions for submitting tasks, executing batches,
 * and waiting for task completion.
 *
 * Extracted from worker-pool.ts as part of Issue #2345 Phase 4.
 *
 * @module agents/worker-pool/worker-pool-execution
 */

import type {
  Task,
  TaskOptions,
  TaskResult,
  ExecuteOptions,
  BatchResult,
} from './types.js';
import type { WorkerPoolTaskQueue as TaskQueue } from './task-queue.js';
import type { EmitData } from './worker-pool-health.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Context for task submission operations.
 */
export interface SubmissionContext {
  /** Task queue */
  taskQueue: TaskQueue;
  /** Emit pool event */
  emit(type: string, data?: EmitData): void;
  /** Trigger task assignment after submission */
  triggerAssignment(): Promise<void>;
}

/**
 * Context for batch execution.
 * Provides callbacks for task operations needed by executeBatch.
 */
export interface BatchContext {
  /** Submit multiple tasks */
  submitBatch(optionsList: TaskOptions[]): Task[];
  /** Wait for a specific task to complete */
  waitForTask(taskId: string, timeout?: number): Promise<TaskResult>;
  /** Cancel a task */
  cancelTask(taskId: string): boolean;
}

// ============================================================================
// Task Submission
// ============================================================================

/**
 * Submit a single task to the pool.
 *
 * Creates a task from options, emits a queued event,
 * and triggers task assignment.
 *
 * @param ctx - Submission context
 * @param options - Task options
 * @returns The created task
 */
export function submitTask(ctx: SubmissionContext, options: TaskOptions): Task {
  const task = ctx.taskQueue.enqueue(options);
  ctx.emit('task:queued', { taskId: task.id });

  // Try to assign task immediately
  void ctx.triggerAssignment();

  return task;
}

/**
 * Submit multiple tasks to the pool.
 *
 * @param ctx - Submission context
 * @param optionsList - Array of task options
 * @returns Array of created tasks
 */
export function submitBatchTasks(ctx: SubmissionContext, optionsList: TaskOptions[]): Task[] {
  const tasks = ctx.taskQueue.enqueueBatch(optionsList);
  void ctx.triggerAssignment();
  return tasks;
}

// ============================================================================
// Batch Execution
// ============================================================================

/**
 * Execute multiple tasks and wait for all to complete.
 *
 * Submits all tasks, waits for completion, and handles
 * fail-fast mode if requested.
 *
 * @param ctx - Batch context providing task operations
 * @param optionsList - Array of task options
 * @param execOptions - Execution options
 * @returns Batch result with all task results
 */
export async function executeBatch(
  ctx: BatchContext,
  optionsList: TaskOptions[],
  execOptions: ExecuteOptions = {}
): Promise<BatchResult> {
  const startTime = Date.now();
  const results: TaskResult[] = [];
  let successCount = 0;
  let failedCount = 0;

  // Submit all tasks
  const tasks = ctx.submitBatch(optionsList);
  const totalTasks = tasks.length;

  // Create promise for each task
  const taskPromises = tasks.map(task => ctx.waitForTask(task.id));

  // Wait for all tasks
  const settledResults = await Promise.allSettled(taskPromises);

  for (let i = 0; i < settledResults.length; i++) {
    const settled = settledResults[i];
    const task = tasks[i];

    if (settled.status === 'fulfilled') {
      results.push(settled.value);
      if (settled.value.status === 'completed') {
        successCount++;
      } else {
        failedCount++;
      }
    } else {
      // Task promise rejected
      const result: TaskResult = {
        taskId: task.id,
        status: 'failed',
        error: settled.reason?.message ?? 'Unknown error',
      };
      results.push(result);
      failedCount++;
    }

    // Progress callback
    execOptions.onProgress?.(i + 1, totalTasks);

    // Fail fast
    if (execOptions.failFast && failedCount > 0) {
      // Cancel remaining tasks
      for (let j = i + 1; j < tasks.length; j++) {
        ctx.cancelTask(tasks[j].id);
      }
      break;
    }
  }

  return {
    results,
    successCount,
    failedCount,
    totalDuration: Date.now() - startTime,
    allSucceeded: failedCount === 0,
  };
}

// ============================================================================
// Task Completion
// ============================================================================

/**
 * Wait for a specific task to complete.
 *
 * Polls the task queue at regular intervals until the task
 * completes, fails, is cancelled, or times out.
 *
 * @param taskQueue - Task queue to poll
 * @param taskId - Task ID to wait for
 * @param timeout - Timeout in milliseconds
 * @returns Promise resolving to task result
 */
export function waitForTaskCompletion(
  taskQueue: TaskQueue,
  taskId: string,
  timeout: number,
): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line prefer-const
    let timeoutId: NodeJS.Timeout | undefined;

    const checkCompletion = () => {
      const task = taskQueue.get(taskId);
      const historyTask = taskQueue.getHistory().find(t => t.id === taskId);

      if (historyTask?.result) {
        if (timeoutId) { clearTimeout(timeoutId); }
        resolve(historyTask.result);
        return true;
      }

      if (task?.status === 'failed' || task?.status === 'cancelled') {
        if (timeoutId) { clearTimeout(timeoutId); }
        reject(new Error(task.result?.error ?? `Task ${task.status}`));
        return true;
      }

      return false;
    };

    // Check immediately
    if (checkCompletion()) { return; }

    // Set timeout
    timeoutId = setTimeout(() => {
      reject(new Error(`Task ${taskId} timed out`));
    }, timeout);

    // Poll for completion
    const intervalId = setInterval(() => {
      if (checkCompletion()) {
        clearInterval(intervalId);
      }
    }, 100);
  });
}
