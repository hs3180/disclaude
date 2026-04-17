/**
 * Tests for Worker Pool Health - Task assignment and execution.
 *
 * Verifies task-to-worker assignment, retry logic, error recovery,
 * and worker release after task completion.
 *
 * Issue #1617: Phase 3 - worker-pool module test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assignTasksToWorkers,
  executeTaskOnWorker,
  type AssignmentContext,
} from './worker-pool-health.js';
import type { Task, WorkerHandle, WorkerPoolConfig } from './types.js';

// Mock @disclaude/core to avoid real logger
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

import { AgentFactory } from '../factory.js';

const mockAgentFactory = vi.mocked(AgentFactory);

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Test Task',
    prompt: 'Do something',
    chatId: 'oc_test',
    callbacks: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    },
    enabled: true,
    createdAt: new Date(),
    status: 'pending',
    retryCount: 0,
    priority: 'normal',
    timeout: 300000,
    maxRetries: 0,
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

function createMockTaskQueue(tasks: Task[] = []) {
  const pending = [...tasks.filter(t => t.status === 'pending')];
  return {
    hasAvailableTasks: vi.fn(() => pending.length > 0),
    dequeue: vi.fn(() => pending.shift()),
    updateStatus: vi.fn(),
    getHistory: vi.fn(() => []),
    enqueue: vi.fn(),
  };
}

function createMockAssignmentContext(
  overrides: Partial<AssignmentContext> = {},
): AssignmentContext {
  const workers = new Map<string, WorkerHandle>();
  const taskQueue = createMockTaskQueue();

  return {
    workers,
    taskQueue: taskQueue as any,
    config: {
      maxWorkers: 5,
      minIdleWorkers: 1,
      defaultTimeout: 300000,
      maxRetries: 2,
      enablePriority: true,
      maxHistorySize: 100,
      resultRetentionTime: 3600000,
    } satisfies Required<WorkerPoolConfig>,
    callbacks: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    },
    runningTasks: new Map(),
    emit: vi.fn(),
    getIdleWorker: vi.fn(() => undefined),
    createWorker: vi.fn(() => createMockWorker()),
    updateWorkerStatus: vi.fn(),
    ensureMinIdleWorkers: vi.fn(),
    ...overrides,
  };
}

describe('worker-pool-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // assignTasksToWorkers
  // ==========================================================================

  describe('assignTasksToWorkers', () => {
    it('should do nothing when no tasks available', async () => {
      const ctx = createMockAssignmentContext({
        taskQueue: createMockTaskQueue() as any,
      });

      await assignTasksToWorkers(ctx);

      expect(ctx.getIdleWorker).not.toHaveBeenCalled();
    });

    it('should assign task to idle worker', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const taskQueue = createMockTaskQueue([task]);

      const ctx = createMockAssignmentContext({
        taskQueue: taskQueue as any,
        getIdleWorker: vi.fn(() => worker),
      });

      await assignTasksToWorkers(ctx);

      expect(taskQueue.dequeue).toHaveBeenCalled();
    });

    it('should create a new worker when no idle worker but under limit', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const taskQueue = createMockTaskQueue([task]);

      let callCount = 0;
      const ctx = createMockAssignmentContext({
        workers: new Map([['existing', createMockWorker({ status: 'busy' })]]),
        taskQueue: taskQueue as any,
        getIdleWorker: vi.fn(() => {
          callCount++;
          // First call: no idle worker; second call after create: returns worker
          return callCount > 1 ? worker : undefined;
        }),
        createWorker: vi.fn(() => {
          const w = createMockWorker();
          ctx.workers.set(w.id, w);
          return w;
        }),
      });

      await assignTasksToWorkers(ctx);

      expect(ctx.createWorker).toHaveBeenCalled();
    });

    it('should stop assigning when pool is full', async () => {
      const taskQueue = createMockTaskQueue([createMockTask(), createMockTask()]);
      const ctx = createMockAssignmentContext({
        workers: new Map([
          ['w1', createMockWorker({ status: 'busy' })],
          ['w2', createMockWorker({ status: 'busy' })],
          ['w3', createMockWorker({ status: 'busy' })],
          ['w4', createMockWorker({ status: 'busy' })],
          ['w5', createMockWorker({ status: 'busy' })],
        ]),
        taskQueue: taskQueue as any,
        getIdleWorker: vi.fn(() => undefined),
      });

      await assignTasksToWorkers(ctx);

      // Pool is full (5 workers, all busy), no more creation
      expect(ctx.workers.size).toBe(5);
    });

    it('should call ensureMinIdleWorkers after assignment', async () => {
      const taskQueue = createMockTaskQueue();
      const ctx = createMockAssignmentContext({
        taskQueue: taskQueue as any,
      });

      await assignTasksToWorkers(ctx);

      expect(ctx.ensureMinIdleWorkers).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // executeTaskOnWorker
  // ==========================================================================

  describe('executeTaskOnWorker', () => {
    it('should execute task successfully and update worker stats', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(mockAgentFactory.createAgent).toHaveBeenCalledWith('oc_test', ctx.callbacks);
      expect(mockAgent.executeOnce).toHaveBeenCalledWith('oc_test', 'Do something', undefined, undefined);
      expect(mockAgent.dispose).toHaveBeenCalled();
      expect(worker.stats.tasksCompleted).toBe(1);
    });

    it('should emit task:started event', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.emit).toHaveBeenCalledWith('task:started', {
        taskId: 'task-1',
        workerId: 'worker-1',
      });
    });

    it('should emit task:completed event on success', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.emit).toHaveBeenCalledWith('task:completed', {
        taskId: 'task-1',
        workerId: 'worker-1',
      });
    });

    it('should update task status to running at start', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'running');
    });

    it('should update task status to completed on success', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'completed', {
        output: 'Task completed successfully',
      });
    });

    it('should retry on failure when retries available', async () => {
      const task = createMockTask({ maxRetries: 1, retryCount: 0 });
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockRejectedValue(new Error('Execution failed')),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      // Should update status back to pending for retry
      expect(ctx.taskQueue.updateStatus).toHaveBeenCalledWith('task-1', 'pending');
      expect(task.retryCount).toBe(1);
      // Should NOT emit task:failed since it's retrying
      expect(ctx.emit).not.toHaveBeenCalledWith('task:failed', expect.anything());
    });

    it('should emit task:failed when no retries remaining', async () => {
      const task = createMockTask({ maxRetries: 0, retryCount: 0 });
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockRejectedValue(new Error('Execution failed')),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.emit).toHaveBeenCalledWith('task:failed', {
        taskId: 'task-1',
        workerId: 'worker-1',
        data: 'Execution failed',
      });
      expect(worker.stats.tasksFailed).toBe(1);
    });

    it('should set worker status to idle after task completion', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.updateWorkerStatus).toHaveBeenCalledWith('worker-1', 'idle');
    });

    it('should not set disabled worker to idle after task', async () => {
      const task = createMockTask();
      const worker = createMockWorker({ status: 'disabled' });
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      // Worker status should remain disabled, not updated to idle
      expect(ctx.updateWorkerStatus).not.toHaveBeenCalledWith('worker-1', 'idle');
    });

    it('should track running task during execution', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      // Task was added to runningTasks during execution
      // (then removed in finally)
      expect(ctx.runningTasks.has('task-1')).toBe(false);
    });

    it('should pass senderOpenId to agent', async () => {
      const task = createMockTask({ senderOpenId: 'ou_user123' });
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(mockAgent.executeOnce).toHaveBeenCalledWith(
        'oc_test',
        'Do something',
        undefined,
        'ou_user123',
      );
    });

    it('should handle non-Error thrown values in failure path', async () => {
      const task = createMockTask({ maxRetries: 0 });
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockRejectedValue('string error'),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();

      await executeTaskOnWorker(ctx, task, worker);

      expect(ctx.emit).toHaveBeenCalledWith('task:failed', {
        taskId: 'task-1',
        workerId: 'worker-1',
        data: 'string error',
      });
    });

    it('should update worker execution time stats from task history', async () => {
      const task = createMockTask();
      const worker = createMockWorker();
      const mockAgent = {
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      mockAgentFactory.createAgent.mockReturnValue(mockAgent as any);

      const ctx = createMockAssignmentContext();
      (ctx.taskQueue.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 'task-1', result: { duration: 1500 } },
      ]);

      await executeTaskOnWorker(ctx, task, worker);

      expect(worker.stats.totalExecutionTime).toBe(1500);
      expect(worker.stats.averageExecutionTime).toBe(1500);
    });
  });
});
