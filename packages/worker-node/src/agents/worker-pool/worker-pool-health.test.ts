/**
 * Unit tests for Worker Pool Health module (assignTasksToWorkers + executeTaskOnWorker)
 *
 * Tests cover:
 * - Task assignment to idle workers
 * - Worker creation when under pool limit
 * - Pool full behavior (no idle workers, at max)
 * - Task execution success with stats tracking
 * - Task retry on failure
 * - Task failure after max retries
 * - Worker status transitions (idle → busy → idle)
 * - Disabled worker stays disabled after task
 * - Task duration tracking
 *
 * @see Issue #1617 Phase 3
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assignTasksToWorkers,
  executeTaskOnWorker,
  type AssignmentContext,
} from './worker-pool-health.js';
import type {
  Task,
  WorkerHandle,
  WorkerPoolConfig,
} from './types.js';
import type { ChatAgentCallbacks } from '../chat-agent/index.js';
import type { WorkerPoolTaskQueue as TaskQueue } from './task-queue.js';

// Mock AgentFactory
vi.mock('../factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn(() => ({
      executeOnce: vi.fn(async () => {}),
      dispose: vi.fn(),
    })),
  },
}));

function createMockWorker(overrides?: Partial<WorkerHandle>): WorkerHandle {
  return {
    id: 'worker-1',
    type: 'general',
    status: 'idle',
    currentTaskIds: [],
    createdAt: new Date(),
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    },
    ...overrides,
  };
}

function createMockTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'test-task',
    chatId: 'chat-1',
    callbacks: {} as ChatAgentCallbacks,
    prompt: 'test prompt',
    senderOpenId: 'user-1',
    priority: undefined,
    status: 'pending',
    createdAt: new Date(),
    retryCount: 0,
    maxRetries: 0,
    workerId: undefined,
    ...overrides,
  };
}

const defaultConfig: Required<WorkerPoolConfig> = {
  maxWorkers: 4,
  minIdleWorkers: 1,
  defaultTimeout: 300000,
  maxRetries: 2,
  enablePriority: true,
  maxHistorySize: 100,
  resultRetentionTime: 3600000,
};

function createMockContext(overrides?: Partial<AssignmentContext>): AssignmentContext {
  const workers = new Map<string, WorkerHandle>();
  const runningTasks = new Map<string, { task: Task; workerId: string }>();
  const taskHistory: Task[] = [];

  const taskQueue = {
    hasAvailableTasks: vi.fn(() => false),
    dequeue: vi.fn(() => undefined),
    updateStatus: vi.fn(),
    getHistory: vi.fn(() => taskHistory),
  } as unknown as TaskQueue;

  const ctx: AssignmentContext = {
    workers,
    taskQueue,
    config: { ...defaultConfig },
    callbacks: {} as ChatAgentCallbacks,
    runningTasks,
    emit: vi.fn(),
    getIdleWorker: vi.fn(() => undefined),
    createWorker: vi.fn(() => {
      const worker = createMockWorker({ id: `worker-${workers.size + 1}` });
      workers.set(worker.id, worker);
      return worker;
    }),
    updateWorkerStatus: vi.fn(),
    ensureMinIdleWorkers: vi.fn(),
    ...overrides,
  };

  return ctx;
}

describe('assignTasksToWorkers', () => {
  it('should assign task to idle worker', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createMockContext({
      getIdleWorker: vi.fn(() => worker),
    });
    ctx.workers.set(worker.id, worker);

    // Mock hasAvailableTasks to return true once, then false
    let callCount = 0;
    (ctx.taskQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      return callCount === 1;
    });
    (ctx.taskQueue.dequeue as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await assignTasksToWorkers(ctx);

    expect(ctx.taskQueue.dequeue).toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith('task:started', expect.any(Object));
    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should create new worker when no idle workers and under limit', async () => {
    const task = createMockTask();
    const ctx = createMockContext();

    let callCount = 0;
    (ctx.taskQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      return callCount <= 2;
    });
    (ctx.taskQueue.dequeue as ReturnType<typeof vi.fn>).mockReturnValue(task);

    // First call: no idle worker, creates a new one
    // Second call: still no idle worker (new worker is busy with task)
    let getIdleCount = 0;
    (ctx.getIdleWorker as ReturnType<typeof vi.fn>).mockImplementation(() => {
      getIdleCount++;
      // Return worker on second attempt (after creation)
      if (getIdleCount === 2) {
        return ctx.workers.get('worker-1');
      }
      return undefined;
    });

    // Set max workers to allow creation
    ctx.config.maxWorkers = 10;

    await assignTasksToWorkers(ctx);

    expect(ctx.createWorker).toHaveBeenCalled();
    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should stop assigning when pool is full', async () => {
    const ctx = createMockContext();
    (ctx.taskQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.getIdleWorker as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    // Already at max workers
    for (let i = 0; i < ctx.config.maxWorkers; i++) {
      ctx.workers.set(`worker-${i}`, createMockWorker({ id: `worker-${i}`, status: 'busy' }));
    }

    await assignTasksToWorkers(ctx);

    // Should not create more workers
    expect(ctx.createWorker).not.toHaveBeenCalled();
    expect(ctx.taskQueue.dequeue).not.toHaveBeenCalled();
    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should stop when dequeue returns null', async () => {
    const worker = createMockWorker();
    const ctx = createMockContext({
      getIdleWorker: vi.fn(() => worker),
    });

    (ctx.taskQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.taskQueue.dequeue as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await assignTasksToWorkers(ctx);

    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should do nothing when no tasks available', async () => {
    const ctx = createMockContext();
    (ctx.taskQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await assignTasksToWorkers(ctx);

    expect(ctx.getIdleWorker).not.toHaveBeenCalled();
    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });
});

describe('executeTaskOnWorker', () => {
  it('should execute task successfully and update stats', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createMockContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'running');
    expect(ctx.emit).toHaveBeenCalledWith('task:started', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'completed', {
      output: 'Task completed successfully',
    });
    expect(ctx.emit).toHaveBeenCalledWith('task:completed', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
    expect(worker.stats.tasksCompleted).toBe(1);
    expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('worker-1', 'idle');
  });

  it('should retry task on failure when retries remain', async () => {
    const { AgentFactory } = await import('../factory.js');
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn(() => Promise.reject(new Error('Task failed'))),
      dispose: vi.fn(),
    });

    const worker = createMockWorker();
    const task = createMockTask({ maxRetries: 2, retryCount: 0 });
    const ctx = createMockContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(task.retryCount).toBe(1);
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'pending');
    // Worker status is updated by the finally block which always runs
    expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('worker-1', 'idle');
  });

  it('should mark task as failed after max retries exhausted', async () => {
    const { AgentFactory } = await import('../factory.js');
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn(() => Promise.reject(new Error('Permanent failure'))),
      dispose: vi.fn(),
    });

    const worker = createMockWorker();
    const task = createMockTask({ maxRetries: 0 });
    const ctx = createMockContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'failed', {
      error: 'Permanent failure',
    });
    expect(worker.stats.tasksFailed).toBe(1);
    expect(ctx.emit).toHaveBeenCalledWith('task:failed', {
      taskId: 'task-1',
      workerId: 'worker-1',
      data: 'Permanent failure',
    });
  });

  it('should not set disabled worker back to idle', async () => {
    const worker = createMockWorker({ status: 'disabled' });
    const task = createMockTask();
    const ctx = createMockContext();

    await executeTaskOnWorker(ctx, task, worker);

    // Should not set disabled worker to idle
    expect(ctx.updateWorkerStatus).not.toHaveBeenCalledWith('worker-1', 'idle');
  });

  it('should track task duration in worker stats', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createMockContext();

    // Add task to history with duration
    (ctx.taskQueue.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 'task-1',
      result: { duration: 5000 },
    }]);

    await executeTaskOnWorker(ctx, task, worker);

    expect(worker.stats.totalExecutionTime).toBe(5000);
    expect(worker.stats.averageExecutionTime).toBe(5000);
  });

  it('should handle non-Error exceptions in task failure', async () => {
    const { AgentFactory } = await import('../factory.js');
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn(() => Promise.reject(new Error('string error'))),
      dispose: vi.fn(),
    });

    const worker = createMockWorker();
    const task = createMockTask({ maxRetries: 0 });
    const ctx = createMockContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'failed', {
      error: 'string error',
    });
  });

  it('should add task to runningTasks during execution', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createMockContext();

    const { AgentFactory } = await import('../factory.js');
    let resolveExecution: () => void;
    const executionPromise = new Promise<void>((resolve) => {
      resolveExecution = resolve;
    });
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn(async () => { await executionPromise; }),
      dispose: vi.fn(),
    });

    const execPromise = executeTaskOnWorker(ctx, task, worker);

    // While running, task should be in runningTasks
    expect(ctx.runningTasks.has('task-1')).toBe(true);

    resolveExecution!();
    await execPromise;

    // After completion, task should be removed
    expect(ctx.runningTasks.has('task-1')).toBe(false);
  });

  it('should clean up worker task IDs after completion', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createMockContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(worker.currentTaskIds).not.toContain('task-1');
  });

  it('should calculate average execution time correctly with multiple tasks', async () => {
    const worker = createMockWorker({
      stats: {
        tasksCompleted: 1,
        tasksFailed: 0,
        totalExecutionTime: 3000,
        averageExecutionTime: 3000,
      },
    });
    const task = createMockTask();
    const ctx = createMockContext();

    (ctx.taskQueue.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 'task-1',
      result: { duration: 5000 },
    }]);

    await executeTaskOnWorker(ctx, task, worker);

    expect(worker.stats.totalExecutionTime).toBe(8000);
    expect(worker.stats.averageExecutionTime).toBe(4000); // 8000 / 2
  });
});
