/**
 * SimpleWorker - Basic Worker Agent implementation.
 *
 * A simple worker that executes tasks using a provided executor function.
 * Useful for testing and simple use cases.
 *
 * @module agents/worker/simple-worker
 */

import { createLogger } from '../../utils/logger.js';
import type { AgentMessage } from '../../types/agent.js';
import type {
  WorkerAgent,
  WorkerStatus,
  WorkerCapabilities,
  WorkerStats,
  SubTask,
  TaskResult,
} from './types.js';

const logger = createLogger('SimpleWorker');

/**
 * Function type for task execution.
 */
export type TaskExecutor<T = unknown, R = unknown> = (
  task: SubTask<T, R>
) => Promise<R> | R;

/**
 * Configuration for SimpleWorker.
 */
export interface SimpleWorkerConfig {
  /** Worker ID */
  id: string;
  /** Worker name */
  name?: string;
  /** Task executor function */
  executor: TaskExecutor;
  /** Worker capabilities */
  capabilities?: WorkerCapabilities;
}

/**
 * SimpleWorker - A basic implementation of WorkerAgent.
 *
 * Executes tasks using a provided executor function.
 * Suitable for testing and simple task execution scenarios.
 *
 * @example
 * ```typescript
 * const worker = new SimpleWorker({
 *   id: 'worker-1',
 *   executor: async (task) => {
 *     // Process task and return result
 *     return `Processed: ${task.input}`;
 *   },
 * });
 *
 * const task = { id: 'task-1', input: 'hello' };
 * for await (const msg of worker.execute(task)) {
 *   console.log(msg.content);
 * }
 * ```
 */
export class SimpleWorker implements WorkerAgent {
  readonly type = 'worker' as const;
  readonly id: string;
  readonly name: string;
  readonly capabilities?: WorkerCapabilities;

  private readonly executor: TaskExecutor;
  private _status: WorkerStatus = 'idle';
  private disposed = false;

  // Stats tracking
  private tasksCompleted = 0;
  private tasksFailed = 0;
  private totalExecutionTime = 0;
  private lastActivityAt: number | null = null;

  constructor(config: SimpleWorkerConfig) {
    this.id = config.id;
    this.name = config.name ?? `SimpleWorker-${config.id}`;
    this.executor = config.executor;
    this.capabilities = config.capabilities;

    logger.debug({ workerId: this.id, name: this.name }, 'SimpleWorker created');
  }

  /**
   * Get current worker status.
   */
  get status(): WorkerStatus {
    return this._status;
  }

  /**
   * Execute a subtask.
   *
   * @param task - The subtask to execute
   * @yields Progress messages during execution
   * @returns The task result
   */
  async *execute<T = unknown, R = unknown>(
    task: SubTask<T, R>
  ): AsyncGenerator<AgentMessage, TaskResult<R>, unknown> {
    if (this.disposed) {
      throw new Error('Worker has been disposed');
    }

    this._status = 'busy';
    const startTime = Date.now();

    try {
      // Yield a starting message
      yield {
        role: 'assistant',
        content: `[Worker ${this.name}] Starting task ${task.id}`,
      };

      // Execute the task
      const result = await this.executor(task);

      const duration = Date.now() - startTime;
      task.status = 'completed';
      task.result = result as R;
      task.completedAt = Date.now();

      // Update stats
      this.tasksCompleted++;
      this.totalExecutionTime += duration;
      this.lastActivityAt = Date.now();

      // Yield completion message
      yield {
        role: 'assistant',
        content: `[Worker ${this.name}] Task ${task.id} completed in ${duration}ms`,
      };

      this._status = 'idle';

      return {
        task,
        success: true,
        result: result as R,
        duration,
        workerId: this.id,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      task.status = 'failed';
      task.error = errorMessage;

      // Update stats
      this.tasksFailed++;
      this.totalExecutionTime += duration;
      this.lastActivityAt = Date.now();

      this._status = 'error';

      yield {
        role: 'assistant',
        content: `[Worker ${this.name}] Task ${task.id} failed: ${errorMessage}`,
      };

      // Reset to idle after error
      setTimeout(() => {
        if (this._status === 'error') {
          this._status = 'idle';
        }
      }, 1000);

      return {
        task,
        success: false,
        error: errorMessage,
        duration,
        workerId: this.id,
      };
    }
  }

  /**
   * Check if this worker can handle the given task.
   *
   * @param task - The task to check
   * @returns true if the worker can handle this task
   */
  canHandle(task: SubTask): boolean {
    if (this.disposed || this._status !== 'idle') {
      return false;
    }

    // Check task type if capabilities are defined
    if (this.capabilities?.taskTypes && this.capabilities.taskTypes.length > 0) {
      const taskType = task.metadata?.type as string | undefined;
      if (taskType && !this.capabilities.taskTypes.includes(taskType)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get worker statistics.
   */
  getStats(): WorkerStats {
    const totalTasks = this.tasksCompleted + this.tasksFailed;
    return {
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      avgExecutionTime: totalTasks > 0 ? this.totalExecutionTime / totalTasks : 0,
      lastActivityAt: this.lastActivityAt,
    };
  }

  /**
   * Dispose the worker.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    logger.debug({ workerId: this.id }, 'SimpleWorker disposed');
    this.disposed = true;
    this._status = 'disposed';
  }
}
