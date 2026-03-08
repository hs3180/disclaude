/**
 * WorkerPool - Manages a pool of Worker Agents for parallel task execution.
 *
 * Implements Phase 1 of Issue #897: Worker Pool management.
 *
 * Features:
 * - Dynamic worker creation and management
 * - Worker status tracking
 * - Automatic worker disposal
 * - Pool statistics
 *
 * @example
 * ```typescript
 * const pool = new WorkerPool(config);
 *
 * // Acquire a worker for task execution
 * const worker = await pool.acquire();
 * try {
 *   // Execute task with worker
 *   for await (const msg of worker.agent.execute(taskPrompt)) {
 *     console.log(msg.content);
 *   }
 * } finally {
 *   pool.release(worker);
 * }
 *
 * // Or execute tasks in parallel
 * const results = await pool.executeAll([
 *   { id: '1', prompt: 'Task 1' },
 *   { id: '2', prompt: 'Task 2' },
 * ]);
 *
 * // Clean up
 * pool.dispose();
 * ```
 *
 * @module agents/worker-pool
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentFactory } from './factory.js';
import type {
  Worker,
  WorkerPoolConfig,
  WorkerPoolStats,
  SubTask,
  TaskResult,
} from './worker-types.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<Omit<WorkerPoolConfig, 'autoDispose'>> & { autoDispose: boolean } = {
  maxWorkers: 5,
  maxConcurrent: 5,
  taskTimeout: 300000, // 5 minutes
  autoDispose: false,
};

/**
 * WorkerPool manages a pool of Worker Agents for parallel task execution.
 *
 * The pool:
 * - Creates workers on demand (up to maxWorkers)
 * - Tracks worker status (idle/busy/disposed)
 * - Provides workers for task execution
 * - Disposes workers when the pool is disposed
 */
export class WorkerPool {
  private readonly logger = createLogger('WorkerPool');
  private readonly config: Required<WorkerPoolConfig>;
  private readonly workers: Map<string, Worker> = new Map();
  private disposed = false;

  // Statistics tracking
  private completedTasksCount = 0;
  private failedTasksCount = 0;

  constructor(config: WorkerPoolConfig = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? DEFAULT_CONFIG.maxWorkers,
      maxConcurrent: config.maxConcurrent ?? config.maxWorkers ?? DEFAULT_CONFIG.maxConcurrent,
      taskTimeout: config.taskTimeout ?? DEFAULT_CONFIG.taskTimeout,
      autoDispose: config.autoDispose ?? DEFAULT_CONFIG.autoDispose,
    };

    this.logger.debug({ config: this.config }, 'WorkerPool created');
  }

  /**
   * Get current pool statistics.
   */
  getStats(): WorkerPoolStats {
    const workers = Array.from(this.workers.values());
    return {
      totalWorkers: workers.length,
      idleWorkers: workers.filter(w => w.status === 'idle').length,
      busyWorkers: workers.filter(w => w.status === 'busy').length,
      pendingTasks: 0, // Will be tracked by TaskDispatcher
      completedTasks: this.completedTasksCount,
      failedTasks: this.failedTasksCount,
    };
  }

  /**
   * Get an idle worker from the pool.
   *
   * Creates a new worker if no idle workers are available and
   * the pool hasn't reached maxWorkers.
   *
   * @returns An idle Worker, or undefined if none available
   */
  async acquire(): Promise<Worker | undefined> {
    this.ensureNotDisposed();

    // Try to find an idle worker
    const idleWorker = Array.from(this.workers.values()).find(w => w.status === 'idle');
    if (idleWorker) {
      idleWorker.status = 'busy';
      this.logger.debug({ workerId: idleWorker.id }, 'Acquired existing idle worker');
      return idleWorker;
    }

    // Create a new worker if under limit
    if (this.workers.size < this.config.maxWorkers) {
      const worker = await this.createWorker();
      worker.status = 'busy';
      this.logger.debug({ workerId: worker.id }, 'Created and acquired new worker');
      return worker;
    }

    // No workers available
    this.logger.debug('No workers available (pool at capacity)');
    return undefined;
  }

  /**
   * Release a worker back to the pool.
   *
   * Marks the worker as idle and optionally disposes it if
   * autoDispose is enabled.
   *
   * @param worker - The worker to release
   */
  release(worker: Worker): void {
    this.ensureNotDisposed();

    const poolWorker = this.workers.get(worker.id);
    if (!poolWorker) {
      this.logger.warn({ workerId: worker.id }, 'Attempted to release unknown worker');
      return;
    }

    poolWorker.status = 'idle';
    poolWorker.currentTaskId = undefined;

    this.logger.debug({ workerId: worker.id }, 'Worker released');

    // Auto-dispose if configured
    if (this.config.autoDispose) {
      this.disposeWorker(worker.id);
    }
  }

  /**
   * Execute a single task with a worker from the pool.
   *
   * Acquires a worker, executes the task, and releases the worker.
   *
   * @param task - The task to execute
   * @returns The task result
   */
  async executeTask(task: SubTask): Promise<TaskResult> {
    this.ensureNotDisposed();

    const worker = await this.acquire();
    if (!worker) {
      return {
        taskId: task.id,
        workerId: '',
        success: false,
        error: 'No workers available',
        elapsedMs: 0,
      };
    }

    worker.currentTaskId = task.id;
    const startTime = Date.now();

    try {
      const messages: Array<{ content: string }> = [];
      let lastContent = '';

      // Execute task with the worker's agent
      for await (const msg of worker.agent.execute(task.prompt)) {
        if (msg.content) {
          // Handle both string and ContentBlock[] content
          const contentStr = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
          lastContent = contentStr;
          messages.push({ content: contentStr });
        }
      }

      const elapsedMs = Date.now() - startTime;
      this.completedTasksCount++;

      return {
        taskId: task.id,
        workerId: worker.id,
        success: true,
        content: lastContent,
        elapsedMs,
        messages: messages as TaskResult['messages'],
      };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      this.failedTasksCount++;

      return {
        taskId: task.id,
        workerId: worker.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs,
      };
    } finally {
      this.release(worker);
    }
  }

  /**
   * Execute multiple tasks in parallel.
   *
   * Tasks are executed concurrently up to maxConcurrent limit.
   *
   * @param tasks - Array of tasks to execute
   * @returns Array of task results (in order)
   */
  async executeAll(tasks: SubTask[]): Promise<TaskResult[]> {
    this.ensureNotDisposed();

    // Execute tasks in batches based on maxConcurrent
    const results: TaskResult[] = [];
    const batches: SubTask[][] = [];

    for (let i = 0; i < tasks.length; i += this.config.maxConcurrent) {
      batches.push(tasks.slice(i, i + this.config.maxConcurrent));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(task => this.executeTask(task))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Get a worker by ID.
   *
   * @param workerId - The worker ID
   * @returns The worker, or undefined if not found
   */
  getWorker(workerId: string): Worker | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Get all workers in the pool.
   *
   * @returns Array of all workers
   */
  getWorkers(): Worker[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get all idle workers.
   *
   * @returns Array of idle workers
   */
  getIdleWorkers(): Worker[] {
    return Array.from(this.workers.values()).filter(w => w.status === 'idle');
  }

  /**
   * Get all busy workers.
   *
   * @returns Array of busy workers
   */
  getBusyWorkers(): Worker[] {
    return Array.from(this.workers.values()).filter(w => w.status === 'busy');
  }

  /**
   * Dispose the entire pool and all workers.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    // Dispose all workers
    for (const workerId of this.workers.keys()) {
      this.disposeWorker(workerId);
    }

    this.logger.debug('WorkerPool disposed');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create a new worker.
   */
  private async createWorker(): Promise<Worker> {
    const workerId = `worker-${uuidv4().slice(0, 8)}`;

    // Create a SkillAgent for the worker
    const agentConfig = Config.getAgentConfig();
    const agent = await AgentFactory.createSkillAgent('executor', agentConfig);

    const worker: Worker = {
      id: workerId,
      type: 'general',
      status: 'idle',
      agent,
    };

    this.workers.set(workerId, worker);
    this.logger.debug({ workerId }, 'Created new worker');

    return worker;
  }

  /**
   * Dispose a specific worker.
   */
  private disposeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return;
    }

    worker.status = 'disposed';
    worker.agent.dispose();
    this.workers.delete(workerId);

    this.logger.debug({ workerId }, 'Worker disposed');
  }

  /**
   * Ensure the pool has not been disposed.
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('WorkerPool has been disposed');
    }
  }
}
