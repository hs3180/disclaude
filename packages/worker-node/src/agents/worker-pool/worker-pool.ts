/**
 * Worker Pool - Manages worker agents for parallel task execution.
 *
 * Issue #897: Support master-workers multi-agent collaboration pattern.
 *
 * Features:
 * - Dynamic worker creation and lifecycle management
 * - Task assignment and load balancing
 * - Error recovery and retry handling
 * - Event-based monitoring
 *
 * @module agents/worker-pool/worker-pool
 */

import { randomUUID } from 'crypto';
import { createLogger } from '@disclaude/core';
import { AgentFactory } from '../factory.js';
import { TaskQueue } from './task-queue.js';
import type {
  Task,
  TaskOptions,
  TaskResult,
  WorkerHandle,
  WorkerOptions,
  WorkerStatus,
  WorkerType,
  WorkerPoolConfig,
  WorkerPoolEvent,
  WorkerPoolEventCallback,
  WorkerPoolEventType,
  ExecuteOptions,
  BatchResult,
} from './types.js';
import type { PilotCallbacks } from '../chat-agent/index.js';

const logger = createLogger('WorkerPool');

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<WorkerPoolConfig> = {
  maxWorkers: 5,
  minIdleWorkers: 1,
  defaultTimeout: 300000, // 5 minutes
  maxRetries: 2,
  enablePriority: true,
  maxHistorySize: 100,
  resultRetentionTime: 3600000, // 1 hour
};

// ============================================================================
// Worker Pool Implementation
// ============================================================================

/**
 * Pool of worker agents for parallel task execution.
 *
 * @example
 * ```typescript
 * const pool = new WorkerPool({
 *   maxWorkers: 3,
 *   callbacks: { ... },
 * });
 *
 * // Submit a task
 * const task = pool.submit({
 *   id: 'task-1',
 *   name: 'Analyze data',
 *   prompt: 'Analyze the sales data...',
 *   chatId: 'chat-123',
 *   callbacks: poolCallbacks,
 * });
 *
 * // Execute multiple tasks in parallel
 * const results = await pool.executeBatch([task1, task2, task3]);
 *
 * // Cleanup
 * pool.dispose();
 * ```
 */
export class WorkerPool {
  private config: Required<WorkerPoolConfig>;
  private workers: Map<string, WorkerHandle> = new Map();
  private taskQueue: TaskQueue;
  private callbacks: PilotCallbacks;
  private eventCallbacks: Set<WorkerPoolEventCallback> = new Set();
  private runningTasks: Map<string, { task: Task; workerId: string }> = new Map();
  private disposed = false;

  constructor(config: WorkerPoolConfig, callbacks: PilotCallbacks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
    this.taskQueue = new TaskQueue(this.config.maxHistorySize);

    logger.info({
      maxWorkers: this.config.maxWorkers,
      minIdleWorkers: this.config.minIdleWorkers,
    }, 'Worker pool initialized');
  }

  // --------------------------------------------------------------------------
  // Worker Management
  // --------------------------------------------------------------------------

  /**
   * Create a new worker in the pool.
   *
   * @param options - Worker options
   * @returns Worker handle
   */
  createWorker(options?: Partial<WorkerOptions>): WorkerHandle {
    const workerId = options?.id ?? `worker-${randomUUID().slice(0, 8)}`;
    const workerType: WorkerType = options?.type ?? 'general';

    const handle: WorkerHandle = {
      id: workerId,
      type: workerType,
      skillName: options?.skillName,
      maxConcurrent: options?.maxConcurrent ?? 1,
      defaultTimeout: options?.defaultTimeout ?? this.config.defaultTimeout,
      status: 'idle',
      currentTaskIds: [],
      createdAt: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
      },
    };

    this.workers.set(workerId, handle);
    this.emit('worker:created', { workerId });

    logger.debug({ workerId, type: workerType }, 'Worker created');
    return handle;
  }

  /**
   * Ensure minimum idle workers are available.
   */
  private ensureMinIdleWorkers(): void {
    const idleCount = this.getIdleWorkers().length;
    const needed = this.config.minIdleWorkers - idleCount;

    for (let i = 0; i < needed; i++) {
      this.createWorker({ type: 'general' });
    }
  }

  /**
   * Get an idle worker for task assignment.
   *
   * @returns Idle worker handle or undefined
   */
  private getIdleWorker(): WorkerHandle | undefined {
    return Array.from(this.workers.values()).find(w => w.status === 'idle');
  }

  /**
   * Get all idle workers.
   *
   * @returns Array of idle worker handles
   */
  getIdleWorkers(): WorkerHandle[] {
    return Array.from(this.workers.values()).filter(w => w.status === 'idle');
  }

  /**
   * Update worker status.
   */
  private updateWorkerStatus(workerId: string, status: WorkerStatus): void {
    const worker = this.workers.get(workerId);
    if (!worker) {return;}

    worker.status = status;
    worker.stats.lastActivityAt = new Date();

    const eventType: WorkerPoolEventType = status === 'idle' ? 'worker:idle' : 'worker:busy';
    this.emit(eventType, { workerId });
  }

  /**
   * Get worker by ID.
   *
   * @param workerId - Worker ID
   * @returns Worker handle or undefined
   */
  getWorker(workerId: string): WorkerHandle | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Get all workers.
   *
   * @returns Array of worker handles
   */
  getAllWorkers(): WorkerHandle[] {
    return Array.from(this.workers.values());
  }

  /**
   * Disable a worker (will not receive new tasks).
   *
   * @param workerId - Worker ID
   */
  disableWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'disabled';
      this.emit('worker:error', { workerId });
    }
  }

  /**
   * Dispose a worker.
   *
   * @param workerId - Worker ID
   */
  disposeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {return;}

    // Wait for current tasks to complete
    if (worker.currentTaskIds.length > 0) {
      worker.status = 'disabled'; // Mark for disposal after tasks complete
      return;
    }

    this.workers.delete(workerId);
    this.emit('worker:disposed', { workerId });
    logger.debug({ workerId }, 'Worker disposed');
  }

  // --------------------------------------------------------------------------
  // Task Submission
  // --------------------------------------------------------------------------

  /**
   * Submit a task to the pool.
   *
   * @param options - Task options
   * @returns The created task
   */
  submit(options: TaskOptions): Task {
    const task = this.taskQueue.enqueue(options);
    this.emit('task:queued', { taskId: task.id });

    // Try to assign task immediately
    void this.assignTasks();

    return task;
  }

  /**
   * Submit multiple tasks to the pool.
   *
   * @param optionsList - Array of task options
   * @returns Array of created tasks
   */
  submitBatch(optionsList: TaskOptions[]): Task[] {
    const tasks = this.taskQueue.enqueueBatch(optionsList);
    void this.assignTasks();
    return tasks;
  }

  /**
   * Execute tasks and wait for all to complete.
   *
   * @param optionsList - Array of task options
   * @param execOptions - Execution options
   * @returns Batch result with all task results
   */
  async executeBatch(
    optionsList: TaskOptions[],
    execOptions: ExecuteOptions = {}
  ): Promise<BatchResult> {
    const startTime = Date.now();
    const results: TaskResult[] = [];
    let successCount = 0;
    let failedCount = 0;

    // Submit all tasks
    const tasks = this.submitBatch(optionsList);
    const totalTasks = tasks.length;

    // Create promise for each task
    const taskPromises = tasks.map(task => this.waitForTask(task.id));

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
          this.taskQueue.cancel(tasks[j].id);
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

  /**
   * Wait for a specific task to complete.
   *
   * @param taskId - Task ID
   * @param timeout - Optional timeout in milliseconds
   * @returns Task result
   */
  waitForTask(taskId: string, timeout?: number): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      const timeoutMs = timeout ?? this.config.defaultTimeout;
      // eslint-disable-next-line prefer-const
      let timeoutId: NodeJS.Timeout | undefined;

      const checkCompletion = () => {
        const task = this.taskQueue.get(taskId);
        const historyTask = this.taskQueue.getHistory().find(t => t.id === taskId);

        if (historyTask?.result) {
          if (timeoutId) {clearTimeout(timeoutId);}
          resolve(historyTask.result);
          return true;
        }

        if (task?.status === 'failed' || task?.status === 'cancelled') {
          if (timeoutId) {clearTimeout(timeoutId);}
          reject(new Error(task.result?.error ?? `Task ${task.status}`));
          return true;
        }

        return false;
      };

      // Check immediately
      if (checkCompletion()) {return;}

      // Set timeout
      timeoutId = setTimeout(() => {
        reject(new Error(`Task ${taskId} timed out`));
      }, timeoutMs);

      // Poll for completion
      const intervalId = setInterval(() => {
        if (checkCompletion()) {
          clearInterval(intervalId);
        }
      }, 100);
    });
  }

  // --------------------------------------------------------------------------
  // Task Assignment
  // --------------------------------------------------------------------------

  /**
   * Assign pending tasks to available workers.
   */
  private async assignTasks(): Promise<void> {
    while (this.taskQueue.hasAvailableTasks()) {
      const worker = this.getIdleWorker();
      if (!worker) {
        // No idle workers, try to create one if under limit
        if (this.workers.size < this.config.maxWorkers) {
          this.createWorker();
          continue;
        }
        break; // Pool is full
      }

      const task = this.taskQueue.dequeue();
      if (!task) {break;}

      await this.executeTask(task, worker);
    }

    // Ensure minimum idle workers
    this.ensureMinIdleWorkers();
  }

  /**
   * Execute a task on a worker.
   */
  private async executeTask(task: Task, worker: WorkerHandle): Promise<void> {
    // Update status
    this.taskQueue.updateStatus(task.id, 'running');
    task.workerId = worker.id;
    worker.currentTaskIds.push(task.id);
    this.updateWorkerStatus(worker.id, 'busy');
    this.runningTasks.set(task.id, { task, workerId: worker.id });

    this.emit('task:started', { taskId: task.id, workerId: worker.id });

    logger.debug({ taskId: task.id, workerId: worker.id }, 'Task started');

    try {
      // Create agent for task execution
      const agent = AgentFactory.createTaskAgent(task.chatId, this.callbacks);

      // Execute task
      await agent.executeOnce(
        task.chatId,
        task.prompt,
        undefined,
        task.senderOpenId
      );

      // Task completed
      this.taskQueue.updateStatus(task.id, 'completed', {
        output: 'Task completed successfully',
      });

      worker.stats.tasksCompleted++;
      this.emit('task:completed', { taskId: task.id, workerId: worker.id });

      // Cleanup
      agent.dispose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for retry
      if (task.retryCount < (task.maxRetries ?? 0)) {
        task.retryCount++;
        logger.debug({ taskId: task.id, retryCount: task.retryCount }, 'Task retrying');

        // Re-queue for retry
        this.taskQueue.updateStatus(task.id, 'pending');
        this.runningTasks.delete(task.id);
        worker.currentTaskIds = worker.currentTaskIds.filter(id => id !== task.id);

        // Try again
        void this.assignTasks();
        return;
      }

      // No more retries, mark as failed
      this.taskQueue.updateStatus(task.id, 'failed', { error: errorMessage });
      worker.stats.tasksFailed++;
      this.emit('task:failed', { taskId: task.id, workerId: worker.id, data: errorMessage });
    } finally {
      // Update worker stats
      const taskInHistory = this.taskQueue.getHistory().find(t => t.id === task.id);
      if (taskInHistory?.result?.duration) {
        worker.stats.totalExecutionTime += taskInHistory.result.duration;
        worker.stats.averageExecutionTime =
          worker.stats.totalExecutionTime / worker.stats.tasksCompleted;
      }

      // Release worker
      worker.currentTaskIds = worker.currentTaskIds.filter(id => id !== task.id);
      this.runningTasks.delete(task.id);

      if (worker.status !== 'disabled') {
        this.updateWorkerStatus(worker.id, 'idle');
      }

      // Assign next task
      void this.assignTasks();
    }
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  /**
   * Get task by ID.
   *
   * @param taskId - Task ID
   * @returns Task or undefined
   */
  getTask(taskId: string): Task | undefined {
    return this.taskQueue.get(taskId);
  }

  /**
   * Get task result from history.
   *
   * @param taskId - Task ID
   * @returns Task result or undefined
   */
  getTaskResult(taskId: string): TaskResult | undefined {
    const task = this.taskQueue.getHistory().find(t => t.id === taskId);
    return task?.result;
  }

  /**
   * Get all pending tasks.
   *
   * @returns Array of pending tasks
   */
  getPendingTasks(): Task[] {
    return this.taskQueue.getPending();
  }

  /**
   * Get all running tasks.
   *
   * @returns Array of running tasks
   */
  getRunningTasks(): Task[] {
    return this.taskQueue.getRunning();
  }

  /**
   * Get task queue size.
   *
   * @returns Number of pending tasks
   */
  getQueueSize(): number {
    return this.taskQueue.size();
  }

  /**
   * Get pool statistics.
   *
   * @returns Pool statistics
   */
  getStats(): {
    totalWorkers: number;
    idleWorkers: number;
    busyWorkers: number;
    pendingTasks: number;
    runningTasks: number;
    completedTasks: number;
    failedTasks: number;
  } {
    const workers = Array.from(this.workers.values());
    return {
      totalWorkers: workers.length,
      idleWorkers: workers.filter(w => w.status === 'idle').length,
      busyWorkers: workers.filter(w => w.status === 'busy').length,
      pendingTasks: this.taskQueue.countByStatus('pending'),
      runningTasks: this.taskQueue.countByStatus('running'),
      completedTasks: this.taskQueue.countByStatus('completed'),
      failedTasks: this.taskQueue.countByStatus('failed'),
    };
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  /**
   * Subscribe to pool events.
   *
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onEvent(callback: WorkerPoolEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  /**
   * Emit a pool event.
   */
  private emit(type: WorkerPoolEventType, data?: { workerId?: string; taskId?: string; data?: unknown }): void {
    const event: WorkerPoolEvent = {
      type,
      timestamp: new Date(),
      ...data,
    };

    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        logger.error({ err: error, eventType: type }, 'Error in event callback');
      }
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Cancel a pending task.
   *
   * @param taskId - Task ID
   * @returns True if cancelled, false if not found or running
   */
  cancelTask(taskId: string): boolean {
    return this.taskQueue.cancel(taskId);
  }

  /**
   * Dispose of all workers and clear the queue.
   */
  dispose(): void {
    if (this.disposed) {return;}
    this.disposed = true;

    // Cancel all pending tasks
    this.taskQueue.clear();

    // Dispose all workers
    for (const workerId of this.workers.keys()) {
      this.disposeWorker(workerId);
    }

    this.eventCallbacks.clear();
    logger.info('Worker pool disposed');
  }
}
