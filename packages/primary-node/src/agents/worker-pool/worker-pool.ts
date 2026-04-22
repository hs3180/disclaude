/**
 * Worker Pool - Manages worker agents for parallel task execution.
 *
 * Issue #897: Support master-workers multi-agent collaboration pattern.
 * Issue #2345 Phase 4: Extracted execution logic to worker-pool-execution.ts,
 * health/recovery logic to worker-pool-health.ts,
 * worker management to worker-pool-worker-mgmt.ts.
 *
 * Features:
 * - Dynamic worker creation and lifecycle management
 * - Task assignment and load balancing
 * - Error recovery and retry handling
 * - Event-based monitoring
 *
 * @module agents/worker-pool/worker-pool
 */

import { createLogger, type ChatAgentCallbacks } from '@disclaude/core';
import { TaskQueue } from './task-queue.js';
import type {
  Task,
  TaskOptions,
  TaskResult,
  WorkerHandle,
  WorkerOptions,
  WorkerPoolConfig,
  WorkerPoolEvent,
  WorkerPoolEventCallback,
  WorkerPoolEventType,
  ExecuteOptions,
  BatchResult,
} from './types.js';

// Extracted modules (Issue #2345 Phase 4)
import { submitTask, submitBatchTasks, executeBatch as executeBatchFn, waitForTaskCompletion, type SubmissionContext, type BatchContext } from './worker-pool-execution.js';
import { assignTasksToWorkers, type AssignmentContext, type EmitData } from './worker-pool-health.js';
import {
  createWorkerHandle,
  findIdleWorker,
  getIdleWorkers as getIdleWorkersList,
  updateWorkerStatus as updateStatus,
  ensureMinIdleWorkers as ensureMinIdle,
  type WorkerMgmtContext,
} from './worker-pool-worker-mgmt.js';

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
 * Delegates to worker-pool-execution.ts, worker-pool-health.ts,
 * and worker-pool-worker-mgmt.ts for implementation details.
 */
export class WorkerPool {
  private config: Required<WorkerPoolConfig>;
  private workers: Map<string, WorkerHandle> = new Map();
  private taskQueue: TaskQueue;
  private callbacks: ChatAgentCallbacks;
  private eventCallbacks: Set<WorkerPoolEventCallback> = new Set();
  private runningTasks: Map<string, { task: Task; workerId: string }> = new Map();
  private disposed = false;

  constructor(config: WorkerPoolConfig, callbacks: ChatAgentCallbacks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
    this.taskQueue = new TaskQueue(this.config.maxHistorySize);

    logger.info({
      maxWorkers: this.config.maxWorkers,
      minIdleWorkers: this.config.minIdleWorkers,
    }, 'Worker pool initialized');
  }

  // -- Worker Management (delegates to worker-pool-worker-mgmt.ts) --

  createWorker(options?: Partial<WorkerOptions>): WorkerHandle {
    const handle = createWorkerHandle(this.getWorkerMgmtContext(), this.workers, options);
    logger.debug({ workerId: handle.id, type: handle.type }, 'Worker created');
    return handle;
  }

  getIdleWorkers(): WorkerHandle[] { return getIdleWorkersList(this.workers); }

  getWorker(workerId: string): WorkerHandle | undefined { return this.workers.get(workerId); }

  getAllWorkers(): WorkerHandle[] { return Array.from(this.workers.values()); }

  disableWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) { worker.status = 'disabled'; this.emit('worker:error', { workerId }); }
  }

  disposeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) { return; }
    if (worker.currentTaskIds.length > 0) { worker.status = 'disabled'; return; }
    this.workers.delete(workerId);
    this.emit('worker:disposed', { workerId });
    logger.debug({ workerId }, 'Worker disposed');
  }

  // -- Task Submission (delegates to worker-pool-execution.ts) --

  submit(options: TaskOptions): Task {
    return submitTask(this.getSubmissionContext(), options);
  }

  submitBatch(optionsList: TaskOptions[]): Task[] {
    return submitBatchTasks(this.getSubmissionContext(), optionsList);
  }

  async executeBatch(optionsList: TaskOptions[], execOptions: ExecuteOptions = {}): Promise<BatchResult> {
    return await executeBatchFn(this.getBatchContext(), optionsList, execOptions);
  }

  waitForTask(taskId: string, timeout?: number): Promise<TaskResult> {
    return waitForTaskCompletion(this.taskQueue, taskId, timeout ?? this.config.defaultTimeout);
  }

  // -- Task Assignment (delegates to worker-pool-health.ts) --

  private async assignTasks(): Promise<void> {
    await assignTasksToWorkers(this.getAssignmentContext());
  }

  // -- Query Methods --

  getTask(taskId: string): Task | undefined { return this.taskQueue.get(taskId); }

  getTaskResult(taskId: string): TaskResult | undefined {
    return this.taskQueue.getHistory().find(t => t.id === taskId)?.result;
  }

  getPendingTasks(): Task[] { return this.taskQueue.getPending(); }
  getRunningTasks(): Task[] { return this.taskQueue.getRunning(); }
  getQueueSize(): number { return this.taskQueue.size(); }

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

  onEvent(callback: WorkerPoolEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  private emit(type: WorkerPoolEventType, data?: EmitData): void {
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

  cancelTask(taskId: string): boolean {
    return this.taskQueue.cancel(taskId);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;

    this.taskQueue.clear();

    for (const workerId of this.workers.keys()) {
      this.disposeWorker(workerId);
    }

    this.eventCallbacks.clear();
    logger.info('Worker pool disposed');
  }

  // --------------------------------------------------------------------------
  // Context Builders (for delegation to extracted modules)
  // --------------------------------------------------------------------------

  private getWorkerMgmtContext(): WorkerMgmtContext {
    return {
      config: this.config,
      emit: (type, data) => this.emit(type as WorkerPoolEventType, data),
    };
  }

  private getSubmissionContext(): SubmissionContext {
    return {
      taskQueue: this.taskQueue,
      emit: (type, data) => this.emit(type as WorkerPoolEventType, data),
      triggerAssignment: () => this.assignTasks(),
    };
  }

  private getBatchContext(): BatchContext {
    return {
      submitBatch: (opts) => this.submitBatch(opts),
      waitForTask: (id, timeout) => this.waitForTask(id, timeout),
      cancelTask: (id) => this.cancelTask(id),
    };
  }

  private getAssignmentContext(): AssignmentContext {
    return {
      workers: this.workers,
      taskQueue: this.taskQueue,
      config: this.config,
      callbacks: this.callbacks,
      runningTasks: this.runningTasks,
      emit: (type, data) => this.emit(type, data),
      getIdleWorker: () => findIdleWorker(this.workers),
      createWorker: (opts) => this.createWorker(opts),
      updateWorkerStatus: (id, status) => updateStatus(this.workers, id, status, (t, d) => this.emit(t as WorkerPoolEventType, d)),
      ensureMinIdleWorkers: () => ensureMinIdle(this.getWorkerMgmtContext(), this.workers, this.config.minIdleWorkers),
    };
  }
}
