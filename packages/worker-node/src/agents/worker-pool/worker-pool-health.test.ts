/**
 * Tests for Worker Pool Health - Task assignment, execution, and error recovery.
 *
 * Tests cover:
 * - assignTasksToWorkers: task-to-worker assignment loop, pool limit handling
 * - executeTaskOnWorker: success path, error handling, retry logic, worker release
 * - Edge cases: empty queue, no idle workers, disabled workers
 *
 * @see worker-pool-health.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Mock AgentFactory
vi.mock('../factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn(),
  },
}));

import { assignTasksToWorkers, executeTaskOnWorker, type AssignmentContext } from './worker-pool-health.js';
import type { Task, WorkerHandle } from './types.js';
import type { WorkerPoolTaskQueue } from './task-queue.js';
import { AgentFactory } from '../factory.js';

const mockAgentFactory = vi.mocked(AgentFactory);

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Test task',
    prompt: 'Do something',
    chatId: 'chat-1',
    callbacks: {
      sendMessage: vi.fn(),
      sendInteractive: vi.fn(),
      onEvent: vi.fn(),
    } as any,
    status: 'pending',
    createdAt: new Date(),
    retryCount: 0,
    maxRetries: 0,
    priority: 'normal',
    timeout: 300000,
    dependencies: [],
    ...overrides,
  };
}

function createMockWorker(overrides: Partial<WorkerHandle> = {}): WorkerHandle {
  return {
    id: 'worker-1',
    type: 'general',
    status: 'idle',
    maxConcurrent: 1,
    defaultTimeout: 300000,
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

function createMockContext(overrides: Partial<AssignmentContext> = {}): AssignmentContext {
  const workers = new Map<string, WorkerHandle>();
  const runningTasks = new Map<string, { task: Task; workerId: string }>();

  const mockTaskQueue = {
    hasAvailableTasks: vi.fn().mockReturnValue(false),
    dequeue: vi.fn().mockReturnValue(undefined),
    updateStatus: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  };

  return {
    workers,
    taskQueue: mockTaskQueue as unknown as WorkerPoolTaskQueue,
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
      sendMessage: vi.fn(),
      sendInteractive: vi.fn(),
      onEvent: vi.fn(),
    } as any,
    runningTasks,
    emit: vi.fn(),
    getIdleWorker: vi.fn().mockReturnValue(undefined),
    createWorker: vi.fn(),
    updateWorkerStatus: vi.fn(),
    ensureMinIdleWorkers: vi.fn(),
    ...overrides,
  };
}

describe('worker-pool-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // assignTasksToWorkers
  // ============================================================================
  describe('assignTasksToWorkers', () => {
    it('should do nothing when no tasks are available', async () => {
      const ctx = createMockContext();

      await assignTasksToWorkers(ctx);

      expect(ctx.getIdleWorker).not.toHaveBeenCalled();
      expect(ctx.emit).not.toHaveBeenCalled();
      expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
    });

    it('should assign a task to an idle worker', async () => {
      const worker = createMockWorker({ id: 'w1' });
      const task = createMockTask({ id: 't1' });

      let callCount = 0;
      const ctx = createMockContext({
        getIdleWorker: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {return worker;}
          return undefined;
        }),
      });
      ctx.taskQueue.hasAvailableTasks = vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      (ctx.taskQueue as any).dequeue = vi.fn().mockReturnValue(task);

      // Mock AgentFactory to prevent actual execution
      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      await assignTasksToWorkers(ctx);

      expect(ctx.taskQueue.dequeue).toHaveBeenCalled();
      expect(ctx.emit).toHaveBeenCalledWith('task:started', expect.objectContaining({
        taskId: 't1',
        workerId: 'w1',
      }));
    });

    it('should create a new worker when no idle workers but under limit', async () => {
      const newWorker = createMockWorker({ id: 'new-w1' });
      const task = createMockTask({ id: 't1' });

      let hasAvailableCalls = 0;
      let idleCalls = 0;
      const ctx = createMockContext({
        getIdleWorker: vi.fn().mockImplementation(() => {
          idleCalls++;
          // First call: no idle workers, second call: new worker is idle
          if (idleCalls === 1) {return undefined;}
          return newWorker;
        }),
        createWorker: vi.fn().mockImplementation(() => {
          ctx.workers.set('new-w1', newWorker);
        }),
      });
      ctx.taskQueue.hasAvailableTasks = vi.fn()
        .mockImplementation(() => {
          hasAvailableCalls++;
          return hasAvailableCalls <= 2;
        });
      (ctx.taskQueue as any).dequeue = vi.fn().mockReturnValue(task);
      ctx.workers.set('w-old', createMockWorker({ id: 'w-old' })); // one worker exists

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      await assignTasksToWorkers(ctx);

      expect(ctx.createWorker).toHaveBeenCalled();
    });

    it('should stop assigning when pool is full and no idle workers', async () => {
      const ctx = createMockContext({
        getIdleWorker: vi.fn().mockReturnValue(undefined),
        createWorker: vi.fn(),
      });
      ctx.taskQueue.hasAvailableTasks = vi.fn().mockReturnValue(true);

      // Fill the pool to max (5 workers)
      for (let i = 0; i < 5; i++) {
        ctx.workers.set(`w-${i}`, createMockWorker({ id: `w-${i}` }));
      }

      await assignTasksToWorkers(ctx);

      // Should not dequeue since pool is full
      expect((ctx.taskQueue as any).dequeue).not.toHaveBeenCalled();
    });

    it('should call ensureMinIdleWorkers after assignment', async () => {
      const ctx = createMockContext();

      await assignTasksToWorkers(ctx);

      expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // executeTaskOnWorker
  // ============================================================================
  describe('executeTaskOnWorker', () => {
    it('should execute a task successfully', async () => {
      const task = createMockTask({ id: 't1' });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      // Verify task status updates
      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'running');
      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'completed', {
        output: 'Task completed successfully',
      });

      // Verify events
      expect(ctx.emit).toHaveBeenCalledWith('task:started', expect.objectContaining({
        taskId: 't1',
        workerId: 'w1',
      }));
      expect(ctx.emit).toHaveBeenCalledWith('task:completed', expect.objectContaining({
        taskId: 't1',
        workerId: 'w1',
      }));

      // Verify worker stats
      expect(worker.stats.tasksCompleted).toBe(1);
    });

    it('should assign task to worker and update status', async () => {
      const task = createMockTask({ id: 't1' });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      expect(task.workerId).toBe('w1');
      expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('w1', 'busy');
      // runningTasks is cleaned up in finally block, so it's empty after execution
      expect(ctx.runningTasks.has('t1')).toBe(false);
      expect(worker.currentTaskIds).not.toContain('t1');
    });

    it('should create agent with correct parameters', async () => {
      const task = createMockTask({ id: 't1', chatId: 'chat-1', senderOpenId: 'user-1' });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      await executeTaskOnWorker(ctx, task, worker);

      expect(AgentFactory.createAgent).toHaveBeenCalledWith('chat-1', ctx.callbacks);
      expect(mockAgent.executeOnce).toHaveBeenCalledWith('chat-1', 'Do something', undefined, 'user-1');
      expect(mockAgent.dispose).toHaveBeenCalled();
    });

    it('should dispose agent after successful execution', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const ctx = createMockContext();
      const mockDispose = vi.fn();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: mockDispose,
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      expect(mockDispose).toHaveBeenCalled();
    });

    it('should mark task as failed when execution throws and no retries left', async () => {
      const task = createMockTask({ id: 't1', maxRetries: 0, retryCount: 0 });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockRejectedValue(new Error('Execution failed')),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'failed', {
        error: 'Execution failed',
      });
      expect(worker.stats.tasksFailed).toBe(1);
      expect(ctx.emit).toHaveBeenCalledWith('task:failed', expect.objectContaining({
        taskId: 't1',
        workerId: 'w1',
        data: 'Execution failed',
      }));
    });

    it('should retry task when retries remain and execution fails', async () => {
      const task = createMockTask({ id: 't1', maxRetries: 2, retryCount: 0 });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockRejectedValue(new Error('Temporary failure')),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      // Should re-queue the task, not mark as failed
      expect(task.retryCount).toBe(1);
      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'pending');
      expect(ctx.taskQueue.updateStatus).not.toHaveBeenCalledWith('t1', 'failed', expect.anything());
    });

    it('should exhaust retries and then fail', async () => {
      const task = createMockTask({ id: 't1', maxRetries: 1, retryCount: 1 }); // Already retried once
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockRejectedValue(new Error('Still failing')),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'failed', {
        error: 'Still failing',
      });
    });

    it('should release worker after task completion', async () => {
      const task = createMockTask({ id: 't1' });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      // Worker should be released
      expect(worker.currentTaskIds).not.toContain('t1');
      expect(ctx.runningTasks.has('t1')).toBe(false);
      expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('w1', 'idle');
    });

    it('should not set worker to idle if worker is disabled', async () => {
      const task = createMockTask({ id: 't1' });
      const worker = createMockWorker({ id: 'w1', status: 'disabled' });
      // Simulate: worker becomes disabled during execution
      worker.currentTaskIds.push('t1');

      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      // Override updateWorkerStatus to also update the worker
      ctx.updateWorkerStatus = vi.fn().mockImplementation((id, status) => {
        const w = ctx.workers.get(id);
        if (w) {w.status = status;}
      });

      // Set worker status to disabled after task starts
      worker.status = 'disabled';

      await executeTaskOnWorker(ctx, task, worker);

      // Should NOT call updateWorkerStatus with 'idle' for disabled worker
      const idleCall = (ctx.updateWorkerStatus as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[1] === 'idle'
      );
      expect(idleCall).toBeUndefined();
    });

    it('should update execution time stats when history has duration', async () => {
      const task = createMockTask({ id: 't1' });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      ctx.taskQueue.getHistory = vi.fn().mockReturnValue([
        { id: 't1', result: { duration: 5000 } },
      ]);

      await executeTaskOnWorker(ctx, task, worker);

      expect(worker.stats.totalExecutionTime).toBe(5000);
      expect(worker.stats.averageExecutionTime).toBe(5000);
    });

    it('should handle non-Error exceptions in task execution', async () => {
      const task = createMockTask({ id: 't1', maxRetries: 0 });
      const worker = createMockWorker({ id: 'w1' });
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockRejectedValue('string error'),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('t1', 'failed', {
        error: 'string error',
      });
    });

    it('should handle multiple concurrent task IDs on worker', async () => {
      const task = createMockTask({ id: 't1' });
      const worker = createMockWorker({ id: 'w1' });
      worker.currentTaskIds.push('existing-task'); // Worker already has a task
      const ctx = createMockContext();

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      await executeTaskOnWorker(ctx, task, worker);

      // After execution, only the existing task should remain (t1 should be removed)
      expect(worker.currentTaskIds).toEqual(['existing-task']);
    });
  });
});
