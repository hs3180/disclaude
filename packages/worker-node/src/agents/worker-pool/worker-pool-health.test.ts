/**
 * Tests for Worker Pool Health - Task assignment and execution.
 *
 * Covers:
 * - assignTasksToWorkers: task-to-worker assignment loop
 * - executeTaskOnWorker: task execution with retry and error recovery
 *
 * @see Issue #1617 Phase 3
 */

import { describe, it, expect, vi } from 'vitest';
import { assignTasksToWorkers, executeTaskOnWorker, type AssignmentContext } from './worker-pool-health.js';
import type { WorkerHandle, Task } from './types.js';
import type { WorkerPoolTaskQueue } from './task-queue.js';

// Mock AgentFactory to avoid real agent creation
vi.mock('../factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn(() => ({
      executeOnce: vi.fn().mockResolvedValue(undefined),
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
    maxConcurrent: 1,
    defaultTimeout: 300000,
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
    name: 'Test task',
    chatId: 'chat-1',
    prompt: 'test prompt',
    callbacks: {} as Task['callbacks'],
    status: 'pending',
    createdAt: new Date(),
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

function createMockTaskQueue(tasks: Task[] = []): WorkerPoolTaskQueue {
  const history: Array<{ id: string; result?: { duration?: number } }> = [];
  return {
    hasAvailableTasks: vi.fn(() => tasks.length > 0),
    dequeue: vi.fn(() => tasks.shift()),
    updateStatus: vi.fn(),
    getHistory: vi.fn(() => history),
  } as unknown as WorkerPoolTaskQueue;
}

function createAssignmentContext(overrides?: Partial<AssignmentContext>): AssignmentContext {
  const workers = new Map<string, WorkerHandle>();
  const taskQueue = createMockTaskQueue();

  return {
    workers,
    taskQueue,
    config: {
      maxWorkers: 5,
      minIdleWorkers: 1,
      defaultTimeout: 300000,
      maxRetries: 2,
      enablePriority: true,
      maxHistorySize: 100,
      resultRetentionTime: 3600000,
    },
    callbacks: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as AssignmentContext['callbacks'],
    runningTasks: new Map(),
    emit: vi.fn(),
    getIdleWorker: vi.fn(() => undefined),
    createWorker: vi.fn(),
    updateWorkerStatus: vi.fn(),
    ensureMinIdleWorkers: vi.fn(),
    ...overrides,
  };
}

describe('assignTasksToWorkers', () => {
  it('should start task on idle worker', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext({
      taskQueue: createMockTaskQueue([task]),
      getIdleWorker: vi.fn(() => worker),
    });

    await assignTasksToWorkers(ctx);

    // After execution completes, task is marked running then completed
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'running');
    expect(ctx.emit).toHaveBeenCalledWith('task:started', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
    // Task completed
    expect(ctx.emit).toHaveBeenCalledWith('task:completed', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
  });

  it('should create a new worker when none idle and under limit', async () => {
    const task = createMockTask();
    const newWorker = createMockWorker({ id: 'new-worker' });
    const workers = new Map<string, WorkerHandle>();
    let callCount = 0;

    const ctx = createAssignmentContext({
      taskQueue: createMockTaskQueue([task]),
      workers, // empty = under limit
      getIdleWorker: vi.fn(() => {
        callCount++;
        // First call: no idle workers yet
        // After createWorker is called, return the new worker on second call
        if (callCount === 1) {return undefined;}
        return newWorker;
      }),
      createWorker: vi.fn(() => {
        workers.set('new-worker', newWorker);
      }),
    });

    await assignTasksToWorkers(ctx);

    expect(ctx.createWorker).toHaveBeenCalled();
  });

  it('should stop when pool is full and no idle workers', async () => {
    const task = createMockTask();
    const ctx = createAssignmentContext({
      taskQueue: createMockTaskQueue([task]),
      workers: new Map([
        ['w1', createMockWorker({ status: 'busy' })],
        ['w2', createMockWorker({ status: 'busy' })],
        ['w3', createMockWorker({ status: 'busy' })],
        ['w4', createMockWorker({ status: 'busy' })],
        ['w5', createMockWorker({ status: 'busy' })],
      ]), // 5 workers = maxWorkers
      getIdleWorker: vi.fn(() => undefined),
    });

    await assignTasksToWorkers(ctx);

    // Task should not be started since no idle worker and pool is full
    expect(ctx.emit).not.toHaveBeenCalledWith('task:started', expect.anything());
  });

  it('should call ensureMinIdleWorkers after assignment', async () => {
    const ctx = createAssignmentContext({
      taskQueue: createMockTaskQueue([]),
    });

    await assignTasksToWorkers(ctx);

    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should break when dequeue returns null', async () => {
    const worker = createMockWorker();
    const emptyQueue = createMockTaskQueue();
    // hasAvailableTasks returns true but dequeue returns null
    (emptyQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (emptyQueue.dequeue as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const ctx = createAssignmentContext({
      taskQueue: emptyQueue,
      getIdleWorker: vi.fn(() => worker),
    });

    await assignTasksToWorkers(ctx);

    // Should break out of the loop without error
    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });
});

describe('executeTaskOnWorker', () => {
  it('should execute task and mark as completed', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    // Task was set to running
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'running');
    // Task completed successfully
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      'task-1', 'completed', { output: 'Task completed successfully' },
    );
    expect(worker.stats.tasksCompleted).toBe(1);
    expect(ctx.emit).toHaveBeenCalledWith('task:started', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
    expect(ctx.emit).toHaveBeenCalledWith('task:completed', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
  });

  it('should assign worker to task at start', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    // Worker ID was assigned to the task
    expect(task.workerId).toBe('worker-1');
  });

  it('should mark task completed on success', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      'task-1', 'completed', { output: 'Task completed successfully' },
    );
    expect(worker.stats.tasksCompleted).toBe(1);
    expect(ctx.emit).toHaveBeenCalledWith('task:completed', {
      taskId: 'task-1',
      workerId: 'worker-1',
    });
  });

  it('should retry task on failure when retries remain', async () => {
    const { AgentFactory } = await import('../factory.js');
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn().mockRejectedValue(new Error('Task failed')),
      dispose: vi.fn(),
    });

    const worker = createMockWorker();
    const task = createMockTask({ retryCount: 0, maxRetries: 2 });
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(task.retryCount).toBe(1);
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'pending');
  });

  it('should mark task failed when no retries remain', async () => {
    const { AgentFactory } = await import('../factory.js');
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn().mockRejectedValue(new Error('Task failed permanently')),
      dispose: vi.fn(),
    });

    const worker = createMockWorker();
    const task = createMockTask({ retryCount: 2, maxRetries: 2 });
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      'task-1', 'failed', { error: 'Task failed permanently' },
    );
    expect(worker.stats.tasksFailed).toBe(1);
    expect(ctx.emit).toHaveBeenCalledWith('task:failed', {
      taskId: 'task-1',
      workerId: 'worker-1',
      data: 'Task failed permanently',
    });
  });

  it('should handle non-Error throws in task failure', async () => {
    const { AgentFactory } = await import('../factory.js');
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      executeOnce: vi.fn().mockRejectedValue('string error'),
      dispose: vi.fn(),
    });

    const worker = createMockWorker();
    const task = createMockTask({ retryCount: 2, maxRetries: 2 });
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      'task-1', 'failed', { error: 'string error' },
    );
  });

  it('should set worker to idle after task completes', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('worker-1', 'idle');
  });

  it('should not set disabled worker to idle after task completes', async () => {
    const worker = createMockWorker({ status: 'disabled' });
    const task = createMockTask();
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    // updateWorkerStatus should NOT be called for disabled workers
    expect(ctx.updateWorkerStatus).not.toHaveBeenCalledWith('worker-1', 'idle');
  });

  it('should clean up runningTasks after task completes', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext();

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.runningTasks.has('task-1')).toBe(false);
    expect(worker.currentTaskIds).not.toContain('task-1');
  });

  it('should update worker execution stats when task has duration', async () => {
    const worker = createMockWorker();
    const task = createMockTask();
    const ctx = createAssignmentContext();

    // Mock getHistory to return task with duration
    (ctx.taskQueue.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 'task-1',
      result: { duration: 5000 },
    }]);

    await executeTaskOnWorker(ctx, task, worker);

    expect(worker.stats.totalExecutionTime).toBe(5000);
    expect(worker.stats.averageExecutionTime).toBe(5000);
  });
});
