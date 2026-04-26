/**
 * Unit tests for Worker Pool Health - Task assignment, execution, and error recovery.
 *
 * Issue #1617 Phase 3: Tests for worker-pool task execution engine.
 *
 * Covers:
 * - assignTasksToWorkers: task assignment loop, pool full, no idle workers
 * - executeTaskOnWorker: success path, failure path, retry logic
 * - Worker release and status management after task completion
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assignTasksToWorkers, executeTaskOnWorker, type AssignmentContext } from './worker-pool-health.js';
import type { Task, WorkerHandle, WorkerPoolConfig } from './types.js';
import type { WorkerPoolTaskQueue } from './task-queue.js';

// Mock AgentFactory
vi.mock('../factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn(() => ({
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    })),
  },
}));

// Helper to create a worker handle
function createWorker(id: string, status: 'idle' | 'busy' | 'disabled' = 'idle'): WorkerHandle {
  return {
    id,
    type: 'general',
    status,
    currentTaskIds: [],
    createdAt: new Date(),
    maxConcurrent: 1,
    defaultTimeout: 30000,
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    },
  };
}

// Helper to create a task
function createTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    chatId: `chat-${id}`,
    prompt: `Prompt for ${id}`,
    status: 'pending',
    createdAt: new Date(),
    retryCount: 0,
    callbacks: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as Task;
}

// Helper to create a mock task queue
function createMockQueue(tasks: Task[] = []): WorkerPoolTaskQueue {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const pendingQueue = tasks.filter(t => t.status === 'pending').map(t => t.id);
  const completedTasks: Task[] = [];

  return {
    hasAvailableTasks: vi.fn(() => pendingQueue.length > 0),
    dequeue: vi.fn(() => {
      if (pendingQueue.length === 0) {return undefined;}
      const id = pendingQueue.shift()!;
      return taskMap.get(id);
    }),
    updateStatus: vi.fn((id: string, status: string, result?: unknown) => {
      const task = taskMap.get(id);
      if (task) {
        task.status = status as Task['status'];
        if (result && typeof result === 'object') {
          task.result = { taskId: id, status, ...(result as object) } as Task['result'];
        }
      }
    }),
    getHistory: vi.fn(() => completedTasks),
    size: vi.fn(() => pendingQueue.length),
    enqueue: vi.fn(),
    peek: vi.fn(),
    getTask: vi.fn((id: string) => taskMap.get(id)),
    cancel: vi.fn(),
    clear: vi.fn(),
  } as unknown as WorkerPoolTaskQueue;
}

// Helper to create an AssignmentContext
function createMockContext(overrides: Partial<AssignmentContext> = {}): AssignmentContext {
  const workers = new Map<string, WorkerHandle>();
  const taskQueue = createMockQueue();
  const runningTasks = new Map<string, { task: Task; workerId: string }>();
  const config: Required<WorkerPoolConfig> = {
    maxWorkers: 5,
    minIdleWorkers: 1,
    defaultTimeout: 30000,
    maxRetries: 2,
    enablePriority: true,
    maxHistorySize: 100,
    resultRetentionTime: 3600000,
  };

  return {
    workers,
    taskQueue,
    config,
    callbacks: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    runningTasks,
    emit: vi.fn(),
    getIdleWorker: vi.fn(() => {
      for (const w of workers.values()) {
        if (w.status === 'idle') {return w;}
      }
      return undefined;
    }),
    createWorker: vi.fn((opts) => {
      const worker = createWorker(`worker-${Date.now()}`, 'idle');
      if (opts?.type) {worker.type = opts.type;}
      workers.set(worker.id, worker);
      return worker;
    }),
    updateWorkerStatus: vi.fn((id: string, status: string) => {
      const worker = workers.get(id);
      if (worker) {worker.status = status as WorkerHandle['status'];}
    }),
    ensureMinIdleWorkers: vi.fn(),
    ...overrides,
  };
}

describe('assignTasksToWorkers', () => {
  let ctx: AssignmentContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should assign tasks to idle workers', async () => {
    const worker = createWorker('w1', 'idle');
    ctx.workers.set('w1', worker);

    const task = createTask('t1');
    ctx.taskQueue = createMockQueue([task]);

    await assignTasksToWorkers(ctx);

    expect(ctx.taskQueue.dequeue).toHaveBeenCalled();
  });

  it('should create new worker when no idle workers available and pool is not full', async () => {
    const task = createTask('t1');
    ctx.taskQueue = createMockQueue([task]);
    // No workers initially, maxWorkers is 5

    // getIdleWorker returns undefined first, then createWorker is called
    let createCalled = false;
    (ctx.getIdleWorker as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (!createCalled) {
        createCalled = true;
        return undefined;
      }
      // After createWorker is called, return the new worker
      for (const w of ctx.workers.values()) {
        if (w.status === 'idle') {return w;}
      }
      return undefined;
    });

    await assignTasksToWorkers(ctx);

    expect(ctx.createWorker).toHaveBeenCalled();
  });

  it('should stop when pool is full and no idle workers', async () => {
    // Fill the pool
    for (let i = 0; i < 5; i++) {
      ctx.workers.set(`w${i}`, createWorker(`w${i}`, 'busy'));
    }

    const task = createTask('t1');
    ctx.taskQueue = createMockQueue([task]);

    (ctx.getIdleWorker as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await assignTasksToWorkers(ctx);

    // Should not create more workers since pool is full
    expect(ctx.createWorker).not.toHaveBeenCalled();
  });

  it('should call ensureMinIdleWorkers after assignment', async () => {
    ctx.taskQueue = createMockQueue([]); // No tasks

    await assignTasksToWorkers(ctx);

    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should handle empty task queue', async () => {
    ctx.taskQueue = createMockQueue([]);

    await assignTasksToWorkers(ctx);

    expect(ctx.taskQueue.dequeue).not.toHaveBeenCalled();
    expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should stop when dequeue returns undefined', async () => {
    const worker = createWorker('w1', 'idle');
    ctx.workers.set('w1', worker);

    ctx.taskQueue = createMockQueue();
    (ctx.taskQueue.hasAvailableTasks as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.taskQueue.dequeue as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await assignTasksToWorkers(ctx);

    // Should have attempted to dequeue but stopped when got undefined
    expect(ctx.taskQueue.dequeue).toHaveBeenCalled();
  });
});

describe('executeTaskOnWorker', () => {
  let ctx: AssignmentContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should execute task and update status to completed', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'running');
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      't1',
      'completed',
      expect.objectContaining({ output: expect.any(String) }),
    );
    expect(ctx.emit).toHaveBeenCalledWith('task:started', expect.objectContaining({ taskId: 't1' }));
    expect(ctx.emit).toHaveBeenCalledWith('task:completed', expect.objectContaining({ taskId: 't1' }));
    expect(worker.stats.tasksCompleted).toBe(1);
  });

  it('should update worker status to busy during execution', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('w1', 'busy');
  });

  it('should add task to runningTasks during execution', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    // After completion, runningTasks should be cleared
    expect(ctx.runningTasks.has('t1')).toBe(false);
  });

  it('should add task ID to worker currentTaskIds during execution', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    // After completion, task ID should be removed
    expect(worker.currentTaskIds).not.toContain('t1');
  });

  it('should set task workerId during execution', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    expect(task.workerId).toBe('w1');
  });

  it('should release worker to idle after successful task', async () => {
    const worker = createWorker('w1', 'busy');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('w1', 'idle');
  });

  it('should NOT release disabled worker to idle', async () => {
    const worker = createWorker('w1', 'disabled');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    // Should not set status to idle for disabled worker
    // Worker might have been set to busy but not back to idle
    // The key point is the final status check for disabled
    expect(worker.status).toBe('disabled');
  });

  it('should retry task on failure when retries remain', async () => {
    const { AgentFactory } = await import('../factory.js');
    const mockAgent = {
      executeOnce: vi.fn().mockRejectedValue(new Error('Task execution failed')),
      dispose: vi.fn(),
    };
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockAgent);

    const worker = createWorker('w1', 'idle');
    const task = createTask('t1', { maxRetries: 2, retryCount: 0 });

    await executeTaskOnWorker(ctx, task, worker);

    // Task should be re-queued for retry
    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'pending');
    expect(task.retryCount).toBe(1);
  });

  it('should mark task as failed when retries exhausted', async () => {
    const { AgentFactory } = await import('../factory.js');
    const mockAgent = {
      executeOnce: vi.fn().mockRejectedValue(new Error('Permanent failure')),
      dispose: vi.fn(),
    };
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockAgent);

    const worker = createWorker('w1', 'idle');
    const task = createTask('t1', { maxRetries: 1, retryCount: 1 }); // Already at max

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      't1',
      'failed',
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(ctx.emit).toHaveBeenCalledWith(
      'task:failed',
      expect.objectContaining({ taskId: 't1' }),
    );
    expect(worker.stats.tasksFailed).toBe(1);
  });

  it('should update execution time stats when task has duration', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    // Mock getHistory to return a task with duration
    (ctx.taskQueue.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 't1', result: { duration: 5000 } },
    ]);

    await executeTaskOnWorker(ctx, task, worker);

    expect(worker.stats.totalExecutionTime).toBe(5000);
    expect(worker.stats.averageExecutionTime).toBe(5000);
  });

  it('should handle non-Error thrown values', async () => {
    const { AgentFactory } = await import('../factory.js');
    const mockAgent = {
      executeOnce: vi.fn().mockRejectedValue('string error'),
      dispose: vi.fn(),
    };
    (AgentFactory.createAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockAgent);

    const worker = createWorker('w1', 'idle');
    const task = createTask('t1', { maxRetries: 0 });

    await executeTaskOnWorker(ctx, task, worker);

    expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith(
      't1',
      'failed',
      expect.objectContaining({ error: 'string error' }),
    );
  });

  it('should trigger assignTasksToWorkers after completion', async () => {
    const worker = createWorker('w1', 'idle');
    const task = createTask('t1');

    await executeTaskOnWorker(ctx, task, worker);

    // The finally block calls assignTasksToWorkers which calls ensureMinIdleWorkers
    // We can verify the side effects occurred
    expect(ctx.updateWorkerStatus).toHaveBeenCalled();
  });

  it('should calculate average execution time correctly with multiple tasks', async () => {
    const worker = createWorker('w1', 'idle');
    worker.stats.tasksCompleted = 2;
    worker.stats.totalExecutionTime = 8000;
    worker.stats.averageExecutionTime = 4000;

    const task = createTask('t1');
    (ctx.taskQueue.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 't1', result: { duration: 4000 } },
    ]);

    await executeTaskOnWorker(ctx, task, worker);

    // tasksCompleted incremented to 3, totalExecutionTime += 4000 = 12000
    // averageExecutionTime = 12000 / 3 = 4000
    expect(worker.stats.tasksCompleted).toBe(3);
    expect(worker.stats.totalExecutionTime).toBe(12000);
    expect(worker.stats.averageExecutionTime).toBe(4000);
  });
});
