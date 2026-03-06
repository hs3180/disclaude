/**
 * WorkerPool - Manages a pool of Worker Agents for parallel task execution.
 *
 * Key features:
 * - Dynamic worker creation and management
 * - Worker acquisition with timeout
 * - Parallel task execution with concurrency limits
 * - Worker statistics tracking
 *
 * @module agents/worker/worker-pool
 */

import { createLogger } from '../../utils/logger.js';
import type { WorkerAgent, WorkerPool as IWorkerPool, WorkerPoolConfig, WorkerStats, SubTask, TaskResult } from './types.js';

const logger = createLogger('WorkerPool');

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<Omit<WorkerPoolConfig, 'workerFactory'>> = {
  maxWorkers: 10,
  minIdleWorkers: 1,
  acquireTimeout: 30000, // 30 seconds
  enableQueue: true,
  maxQueueSize: 100,
};

/**
 * Worker Pool implementation.
 *
 * Manages a pool of Worker Agents for parallel task execution.
 * Workers are created on-demand up to maxWorkers limit.
 */
export class WorkerPool implements IWorkerPool {
  private readonly workerFactory: (id: string) => WorkerAgent;
  private readonly maxWorkers: number;
  private readonly minIdleWorkers: number;
  private readonly acquireTimeout: number;
  private readonly workers = new Map<string, WorkerAgent>();
  private readonly busyWorkers = new Set<string>();
  private readonly workerStats = new Map<string, WorkerStats>();
  private workerIdCounter = 0;
  private disposed = false;

  // Waiting queue for acquire requests
  private readonly waitQueue: Array<{
    resolve: (worker: WorkerAgent) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(config: WorkerPoolConfig) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.workerFactory = cfg.workerFactory;
    this.maxWorkers = cfg.maxWorkers;
    this.minIdleWorkers = cfg.minIdleWorkers;
    this.acquireTimeout = cfg.acquireTimeout;

    logger.info(
      { maxWorkers: this.maxWorkers, minIdleWorkers: this.minIdleWorkers },
      'WorkerPool initialized'
    );

    // Pre-create minimum idle workers
    this.ensureMinIdleWorkers();
  }

  /**
   * Ensure minimum number of idle workers exist.
   */
  private ensureMinIdleWorkers(): void {
    const idleCount = this.workers.size - this.busyWorkers.size;
    const toCreate = Math.max(0, this.minIdleWorkers - idleCount);

    for (let i = 0; i < toCreate && this.workers.size < this.maxWorkers; i++) {
      this.createWorker();
    }
  }

  /**
   * Create a new worker instance.
   */
  private createWorker(): WorkerAgent {
    const id = `worker-${++this.workerIdCounter}`;
    const worker = this.workerFactory(id);

    this.workers.set(id, worker);
    this.workerStats.set(id, {
      tasksCompleted: 0,
      tasksFailed: 0,
      avgExecutionTime: 0,
      lastActivityAt: null,
    });

    logger.debug({ workerId: id }, 'Worker created');
    return worker;
  }

  /**
   * Find an available idle worker.
   */
  private findIdleWorker(): WorkerAgent | undefined {
    for (const [id, worker] of this.workers) {
      if (!this.busyWorkers.has(id) && worker.status === 'idle') {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * Acquire an available worker.
   *
   * If no worker is available and maxWorkers not reached, creates a new one.
   * Otherwise, waits until a worker becomes available or timeout.
   *
   * @param timeout - Optional timeout in ms (defaults to pool config)
   * @returns Promise resolving to a worker
   */
  async acquire(timeout?: number): Promise<WorkerAgent> {
    if (this.disposed) {
      throw new Error('WorkerPool has been disposed');
    }

    const timeoutMs = timeout ?? this.acquireTimeout;

    // Try to find an idle worker
    let worker = this.findIdleWorker();

    if (worker) {
      this.busyWorkers.add(worker.id);
      logger.debug({ workerId: worker.id }, 'Worker acquired (idle)');
      return worker;
    }

    // Try to create a new worker if under limit
    if (this.workers.size < this.maxWorkers) {
      worker = this.createWorker();
      this.busyWorkers.add(worker.id);
      logger.debug({ workerId: worker.id }, 'Worker acquired (new)');
      return worker;
    }

    // Wait for a worker to become available
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        // Remove from wait queue
        const index = this.waitQueue.findIndex(w => w.reject === reject);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        reject(new Error(`Worker acquire timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waitQueue.push({
        resolve: (w: WorkerAgent) => {
          clearTimeout(timeoutHandle);
          resolve(w);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        },
        timeout: timeoutHandle,
      });

      logger.debug({ waitQueueSize: this.waitQueue.length }, 'Waiting for available worker');
    });
  }

  /**
   * Release a worker back to the pool.
   *
   * @param worker - The worker to release
   */
  release(worker: WorkerAgent): void {
    if (this.disposed) {
      worker.dispose();
      return;
    }

    this.busyWorkers.delete(worker.id);
    logger.debug({ workerId: worker.id }, 'Worker released');

    // If someone is waiting, give them this worker
    if (this.waitQueue.length > 0 && worker.status === 'idle') {
      const waiter = this.waitQueue.shift();
      if (waiter) {
        this.busyWorkers.add(worker.id);
        waiter.resolve(worker);
        logger.debug({ workerId: worker.id }, 'Worker immediately reassigned to waiter');
      }
    }
  }

  /**
   * Execute a single task using an available worker.
   *
   * @param task - The task to execute
   * @returns Promise resolving to task result
   */
  async executeOne<T = unknown, R = unknown>(task: SubTask<T, R>): Promise<TaskResult<R>> {
    const worker = await this.acquire();
    const startTime = Date.now();

    try {
      task.status = 'running';
      task.startedAt = startTime;

      // Execute and collect final result
      let finalResult: TaskResult<R> | undefined;
      for await (const _msg of worker.execute<T, R>(task)) {
        // Consume messages but we only care about the final return value
      }

      // The execute generator should return TaskResult as the final value
      // If not, we construct a basic result
      const duration = Date.now() - startTime;

      finalResult = {
        task,
        success: true,
        result: task.result as R | undefined,
        duration,
        workerId: worker.id,
      };

      // Update stats
      this.updateStats(worker.id, true, duration);

      return finalResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      task.status = 'failed';
      task.error = errorMessage;

      // Update stats
      this.updateStats(worker.id, false, duration);

      return {
        task,
        success: false,
        error: errorMessage,
        duration,
        workerId: worker.id,
      };
    } finally {
      this.release(worker);
    }
  }

  /**
   * Execute multiple tasks in parallel with a concurrency limit.
   *
   * @param tasks - Tasks to execute
   * @param concurrency - Maximum concurrent executions (defaults to maxWorkers)
   * @returns Promise resolving to all task results
   */
  async executeAll<T = unknown, R = unknown>(
    tasks: SubTask<T, R>[],
    concurrency?: number
  ): Promise<TaskResult<R>[]> {
    const limit = Math.min(concurrency ?? this.maxWorkers, this.maxWorkers);
    const results: TaskResult<R>[] = [];
    const executing = new Set<Promise<TaskResult<R>>>();

    for (const task of tasks) {
      // Wait if at concurrency limit
      if (executing.size >= limit) {
        const completed = await Promise.race(executing);
        results.push(completed);
        executing.delete(Promise.resolve(completed)); // Remove from set
      }

      // Start executing this task
      const promise = this.executeOne<T, R>(task);
      executing.add(promise);
    }

    // Wait for remaining tasks
    const remaining = await Promise.all(executing);
    results.push(...remaining);

    return results;
  }

  /**
   * Update worker statistics.
   */
  private updateStats(workerId: string, success: boolean, duration: number): void {
    const stats = this.workerStats.get(workerId);
    if (!stats) return;

    if (success) {
      stats.tasksCompleted++;
    } else {
      stats.tasksFailed++;
    }

    // Update rolling average
    const totalTasks = stats.tasksCompleted + stats.tasksFailed;
    stats.avgExecutionTime = (stats.avgExecutionTime * (totalTasks - 1) + duration) / totalTasks;
    stats.lastActivityAt = Date.now();
  }

  /**
   * Get the number of total workers.
   */
  size(): number {
    return this.workers.size;
  }

  /**
   * Get the number of available (idle) workers.
   */
  available(): number {
    let count = 0;
    for (const [id, worker] of this.workers) {
      if (!this.busyWorkers.has(id) && worker.status === 'idle') {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the number of busy workers.
   */
  busy(): number {
    return this.busyWorkers.size;
  }

  /**
   * Get worker statistics.
   */
  getStats(): Map<string, WorkerStats> {
    return new Map(this.workerStats);
  }

  /**
   * Dispose all workers and clear the pool.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    logger.info('Disposing WorkerPool');
    this.disposed = true;

    // Reject all waiters
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('WorkerPool disposed'));
    }
    this.waitQueue.length = 0;

    // Dispose all workers
    for (const worker of this.workers.values()) {
      try {
        worker.dispose();
      } catch (err) {
        logger.error({ err, workerId: worker.id }, 'Error disposing worker');
      }
    }

    this.workers.clear();
    this.busyWorkers.clear();
    this.workerStats.clear();
  }
}
