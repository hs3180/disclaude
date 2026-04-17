/**
 * Worker Pool Health - Task assignment, execution, and error recovery.
 *
 * Contains the core task execution engine with retry logic and
 * worker assignment algorithms.
 *
 * Extracted from worker-pool.ts as part of Issue #2345 Phase 4.
 *
 * @module agents/worker-pool/worker-pool-health
 */

import { AgentFactory } from '../factory.js';
import { createLogger } from '@disclaude/core';
import type {
  Task,
  WorkerHandle,
  WorkerStatus,
  WorkerPoolConfig,
  WorkerPoolEventType,
} from './types.js';
import type { ChatAgentCallbacks } from '../chat-agent/index.js';
import type { WorkerPoolTaskQueue as TaskQueue } from './task-queue.js';

const logger = createLogger('WorkerPool:Health');

// ============================================================================
// Types
// ============================================================================

/** Data payload for pool events */
export interface EmitData {
  workerId?: string;
  taskId?: string;
  data?: unknown;
}

/**
 * Context interface for task assignment and execution.
 * Provides access to pool state needed for health/recovery operations.
 */
export interface AssignmentContext {
  /** Worker pool map */
  workers: Map<string, WorkerHandle>;
  /** Task queue */
  taskQueue: TaskQueue;
  /** Pool configuration */
  config: Required<WorkerPoolConfig>;
  /** Agent callbacks */
  callbacks: ChatAgentCallbacks;
  /** Currently running tasks */
  runningTasks: Map<string, { task: Task; workerId: string }>;
  /** Emit pool event */
  emit(type: WorkerPoolEventType, data?: EmitData): void;
  /** Find an idle worker */
  getIdleWorker(): WorkerHandle | undefined;
  /** Create a new worker */
  createWorker(opts?: { type: 'general' }): WorkerHandle;
  /** Update worker status */
  updateWorkerStatus(id: string, status: WorkerStatus): void;
  /** Ensure minimum idle workers are maintained */
  ensureMinIdleWorkers(): void;
}

// ============================================================================
// Task Assignment
// ============================================================================

/**
 * Assign pending tasks from the queue to available workers.
 *
 * Loops through available tasks and idle workers, creating new workers
 * if under the pool limit. Ensures minimum idle workers after assignment.
 *
 * @param ctx - Pool context for task assignment
 */
export async function assignTasksToWorkers(ctx: AssignmentContext): Promise<void> {
  while (ctx.taskQueue.hasAvailableTasks()) {
    const worker = ctx.getIdleWorker();
    if (!worker) {
      // No idle workers, try to create one if under limit
      if (ctx.workers.size < ctx.config.maxWorkers) {
        ctx.createWorker();
        continue;
      }
      break; // Pool is full
    }

    const task = ctx.taskQueue.dequeue();
    if (!task) { break; }

    await executeTaskOnWorker(ctx, task, worker);
  }

  // Ensure minimum idle workers
  ctx.ensureMinIdleWorkers();
}

// ============================================================================
// Task Execution
// ============================================================================

/**
 * Execute a single task on a worker with retry and error recovery.
 *
 * Creates an agent, runs the task, handles retries on failure,
 * and releases the worker when done.
 *
 * @param ctx - Pool context for execution
 * @param task - Task to execute
 * @param worker - Worker to execute on
 */
export async function executeTaskOnWorker(
  ctx: AssignmentContext,
  task: Task,
  worker: WorkerHandle,
): Promise<void> {
  // Update status
  ctx.taskQueue.updateStatus(task.id, 'running');
  task.workerId = worker.id;
  worker.currentTaskIds.push(task.id);
  ctx.updateWorkerStatus(worker.id, 'busy');
  ctx.runningTasks.set(task.id, { task, workerId: worker.id });

  ctx.emit('task:started', { taskId: task.id, workerId: worker.id });

  logger.debug({ taskId: task.id, workerId: worker.id }, 'Task started');

  try {
    // Create agent for task execution
    const agent = AgentFactory.createAgent(task.chatId, ctx.callbacks);

    // Execute task
    await agent.executeOnce(
      task.chatId,
      task.prompt,
      undefined,
      task.senderOpenId
    );

    // Task completed
    ctx.taskQueue.updateStatus(task.id, 'completed', {
      output: 'Task completed successfully',
    });

    worker.stats.tasksCompleted++;
    ctx.emit('task:completed', { taskId: task.id, workerId: worker.id });

    // Cleanup
    agent.dispose();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for retry
    if (task.retryCount < (task.maxRetries ?? 0)) {
      task.retryCount++;
      logger.debug({ taskId: task.id, retryCount: task.retryCount }, 'Task retrying');

      // Re-queue for retry
      ctx.taskQueue.updateStatus(task.id, 'pending');
      ctx.runningTasks.delete(task.id);
      worker.currentTaskIds = worker.currentTaskIds.filter(id => id !== task.id);

      // Try again
      void assignTasksToWorkers(ctx);
      return;
    }

    // No more retries, mark as failed
    ctx.taskQueue.updateStatus(task.id, 'failed', { error: errorMessage });
    worker.stats.tasksFailed++;
    ctx.emit('task:failed', { taskId: task.id, workerId: worker.id, data: errorMessage });
  } finally {
    // Update worker stats
    const taskInHistory = ctx.taskQueue.getHistory().find(t => t.id === task.id);
    if (taskInHistory?.result?.duration) {
      worker.stats.totalExecutionTime += taskInHistory.result.duration;
      worker.stats.averageExecutionTime =
        worker.stats.totalExecutionTime / worker.stats.tasksCompleted;
    }

    // Release worker
    worker.currentTaskIds = worker.currentTaskIds.filter(id => id !== task.id);
    ctx.runningTasks.delete(task.id);

    if (worker.status !== 'disabled') {
      ctx.updateWorkerStatus(worker.id, 'idle');
    }

    // Assign next task
    void assignTasksToWorkers(ctx);
  }
}
