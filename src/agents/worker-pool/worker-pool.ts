/**
 * Worker Pool Implementation - Manages a pool of worker agents.
 *
 * This module implements Phase 1 of Issue #897:
 * - Worker Pool management
 * - Worker lifecycle (acquire/release)
 * - Parallel task execution
 *
 * @module agents/worker-pool/worker-pool
 */

import { createLogger } from '../../utils/logger.js';
import type {
  WorkerPool as IWorkerPool,
  WorkerPoolConfig,
  WorkerPoolStats,
  WorkerAgent,
  SubTask,
  SubTaskResult,
} from './types.js';

const logger = createLogger('WorkerPool');

/**
 * WorkerPool - Manages a pool of worker agents for parallel task execution.
 *
 * Features:
 * - Dynamic worker creation and disposal
 * - Worker acquisition and release
 * - Parallel task execution with limits
 * - Statistics tracking
 *
 * @example
 * ```typescript
 * const pool = new WorkerPool({
 *   maxWorkers: 5,
 *   workerFactory: (config) => new SkillWorkerAgent(config, skillAgentFactory),
 * });
 *
 * // Execute tasks in parallel
 * const results = await pool.executeAll([
 *   { id: '1', description: 'Task 1', input: '...' },
 *   { id: '2', description: 'Task 2', input: '...' },
 * ]);
 *
 * // Or manually manage workers
 * const worker = pool.acquire();
 * if (worker) {
 *   const result = await worker.execute(task);
 *   pool.release(worker);
 * }
 *
 * pool.dispose();
 * ```
 */
export class WorkerPool implements IWorkerPool {
  private readonly config: Required<Omit<WorkerPoolConfig, 'workerFactory'>> & {
    workerFactory: WorkerPoolConfig['workerFactory'];
  };
  private readonly workers: Map<string, WorkerAgent> = new Map();
  private readonly idleWorkers: Set<string> = new Set();
  private readonly busyWorkers: Set<string> = new Set();
  private disposed = false;

  // Statistics
  private totalCompleted = 0;
  private totalFailed = 0;

  constructor(config: WorkerPoolConfig) {
    this.config = {
      maxWorkers: config.maxWorkers,
      minIdleWorkers: config.minIdleWorkers ?? 1,
      workerFactory: config.workerFactory,
      defaultTimeout: config.defaultTimeout ?? 60000,
      idleTimeout: config.idleTimeout ?? 300000, // 5 minutes
    };

    logger.info({ maxWorkers: this.config.maxWorkers }, 'WorkerPool initialized');
  }

  /**
   * Get pool statistics.
   */
  get stats(): WorkerPoolStats {
    return {
      totalWorkers: this.workers.size,
      idleWorkers: this.idleWorkers.size,
      busyWorkers: this.busyWorkers.size,
      pendingTasks: 0, // Pending tasks are tracked by dispatcher
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
    };
  }

  /**
   * Acquire an available worker.
   *
   * If no idle worker is available and we haven't reached maxWorkers,
   * creates a new worker. Otherwise returns undefined.
   *
   * @returns A worker agent, or undefined if none available
   */
  acquire(): WorkerAgent | undefined {
    if (this.disposed) {
      return undefined;
    }

    // Try to get an idle worker
    for (const id of this.idleWorkers) {
      const worker = this.workers.get(id);
      if (worker && worker.isAvailable()) {
        this.idleWorkers.delete(id);
        this.busyWorkers.add(id);
        logger.debug({ workerId: id }, 'Acquired idle worker');
        return worker;
      }
    }

    // Create a new worker if we haven't reached max
    if (this.workers.size < this.config.maxWorkers) {
      const worker = this.createWorker();
      if (worker) {
        this.busyWorkers.add(worker.id);
        logger.debug({ workerId: worker.id }, 'Created and acquired new worker');
        return worker;
      }
    }

    logger.debug('No workers available');
    return undefined;
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

    const id = worker.id;
    if (this.busyWorkers.has(id)) {
      this.busyWorkers.delete(id);

      if (worker.status !== 'disposed' && worker.status !== 'error') {
        this.idleWorkers.add(id);
        logger.debug({ workerId: id }, 'Released worker to idle pool');
      } else {
        // Worker is in error state, remove and dispose
        this.workers.delete(id);
        worker.dispose();
        logger.debug({ workerId: id }, 'Removed error worker');
      }
    }
  }

  /**
   * Execute a batch of tasks in parallel.
   *
   * This method handles worker acquisition and release automatically.
   *
   * @param tasks - Tasks to execute
   * @param options - Execution options
   * @returns Promise resolving to all task results
   */
  async executeAll(
    tasks: SubTask[],
    options?: { maxParallel?: number }
  ): Promise<SubTaskResult[]> {
    if (this.disposed) {
      return tasks.map((task) => ({
        taskId: task.id,
        status: 'failed' as const,
        error: 'WorkerPool has been disposed',
      }));
    }

    const maxParallel = options?.maxParallel ?? this.config.maxWorkers;
    const results: SubTaskResult[] = [];
    const pendingTasks = [...tasks];

    logger.info(
      { taskCount: tasks.length, maxParallel },
      'Starting parallel task execution'
    );

    // Execute tasks with parallelism limit
    while (pendingTasks.length > 0) {
      // Get batch of tasks to execute
      const batch: SubTask[] = [];
      while (batch.length < maxParallel && pendingTasks.length > 0) {
        const task = pendingTasks.shift();
        if (task) batch.push(task);
      }

      // Execute batch in parallel
      const batchResults = await Promise.all(
        batch.map((task) => this.executeTask(task))
      );

      results.push(...batchResults);
    }

    logger.info(
      { totalResults: results.length },
      'Parallel task execution completed'
    );

    return results;
  }

  /**
   * Execute a single task.
   *
   * @param task - Task to execute
   * @returns Promise resolving to task result
   */
  private async executeTask(task: SubTask): Promise<SubTaskResult> {
    // Wait for available worker
    let worker = this.acquire();
    let attempts = 0;
    const maxAttempts = 10;

    while (!worker && attempts < maxAttempts) {
      await this.sleep(100);
      worker = this.acquire();
      attempts++;
    }

    if (!worker) {
      return {
        taskId: task.id,
        status: 'failed',
        error: 'No workers available after maximum attempts',
      };
    }

    try {
      const result = await worker.execute(task);
      if (result.status === 'completed') {
        this.totalCompleted++;
      } else {
        this.totalFailed++;
      }
      return result;
    } catch (error) {
      this.totalFailed++;
      return {
        taskId: task.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.release(worker);
    }
  }

  /**
   * Create a new worker.
   *
   * @returns The created worker, or undefined if creation failed
   */
  private createWorker(): WorkerAgent | undefined {
    try {
      const id = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const worker = this.config.workerFactory({
        id,
        defaultTimeout: this.config.defaultTimeout,
      });

      this.workers.set(id, worker);
      logger.debug({ workerId: id }, 'Created new worker');

      return worker;
    } catch (error) {
      logger.error({ error }, 'Failed to create worker');
      return undefined;
    }
  }

  /**
   * Get a worker by ID.
   *
   * @param id - Worker ID
   * @returns The worker, or undefined if not found
   */
  getWorker(id: string): WorkerAgent | undefined {
    return this.workers.get(id);
  }

  /**
   * Get all workers.
   *
   * @returns Array of all workers
   */
  getWorkers(): WorkerAgent[] {
    return Array.from(this.workers.values());
  }

  /**
   * Sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Dispose of all workers and clean up resources.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    logger.info('Disposing WorkerPool');

    // Dispose all workers
    for (const worker of this.workers.values()) {
      try {
        worker.dispose();
      } catch (error) {
        logger.error({ error, workerId: worker.id }, 'Error disposing worker');
      }
    }

    this.workers.clear();
    this.idleWorkers.clear();
    this.busyWorkers.clear();

    logger.info('WorkerPool disposed');
  }
}
