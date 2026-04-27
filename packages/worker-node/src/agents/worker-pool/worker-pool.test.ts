/**
 * Tests for WorkerPool.
 *
 * @see worker-pool.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core — keep TaskQueue and other exports for task-queue.ts
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

import { WorkerPool } from './worker-pool.js';
import { AgentFactory } from '../factory.js';

const mockAgentFactory = vi.mocked(AgentFactory);

function createMockCallbacks(): any {
  return {
    sendMessage: vi.fn(),
    sendInteractive: vi.fn(),
    onEvent: vi.fn(),
  };
}

describe('WorkerPool', () => {
  let pool: WorkerPool;
  let callbacks: any;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
    pool = new WorkerPool({ maxWorkers: 3, minIdleWorkers: 0 }, callbacks);
  });

  describe('createWorker', () => {
    it('should create a worker with auto-generated ID', () => {
      const worker = pool.createWorker();
      expect(worker.id).toBeDefined();
      expect(worker.id).toMatch(/^worker-/);
      expect(worker.type).toBe('general');
      expect(worker.status).toBe('idle');
      expect(worker.stats.tasksCompleted).toBe(0);
    });

    it('should create a worker with custom options', () => {
      const worker = pool.createWorker({
        id: 'custom-worker-1',
        type: 'skill',
        skillName: 'research',
        maxConcurrent: 3,
      });

      expect(worker.id).toBe('custom-worker-1');
      expect(worker.type).toBe('skill');
      expect(worker.skillName).toBe('research');
      expect(worker.maxConcurrent).toBe(3);
    });

    it('should emit worker:created event', () => {
      const onEvent = vi.fn();
      pool.onEvent(onEvent);

      pool.createWorker();

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'worker:created' })
      );
    });

    it('should register the worker in the pool', () => {
      const worker = pool.createWorker({ id: 'w1' });
      expect(pool.getWorker('w1')).toBe(worker);
    });
  });

  describe('getWorker', () => {
    it('should return undefined for non-existent worker', () => {
      expect(pool.getWorker('nonexistent')).toBeUndefined();
    });

    it('should return the worker by ID', () => {
      const worker = pool.createWorker({ id: 'w1' });
      expect(pool.getWorker('w1')).toBe(worker);
    });
  });

  describe('getAllWorkers', () => {
    it('should return empty array when no workers', () => {
      expect(pool.getAllWorkers()).toEqual([]);
    });

    it('should return all created workers', () => {
      pool.createWorker({ id: 'w1' });
      pool.createWorker({ id: 'w2' });

      const workers = pool.getAllWorkers();
      expect(workers).toHaveLength(2);
    });
  });

  describe('getIdleWorkers', () => {
    it('should return only idle workers', () => {
      pool.createWorker({ id: 'w1' });
      pool.createWorker({ id: 'w2' });
      pool.disableWorker('w2');

      const idle = pool.getIdleWorkers();
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe('w1');
    });

    it('should return empty when all workers are disabled', () => {
      pool.createWorker({ id: 'w1' });
      pool.disableWorker('w1');

      expect(pool.getIdleWorkers()).toHaveLength(0);
    });
  });

  describe('disableWorker', () => {
    it('should set worker status to disabled', () => {
      pool.createWorker({ id: 'w1' });
      pool.disableWorker('w1');

      const worker = pool.getWorker('w1');
      expect(worker?.status).toBe('disabled');
    });

    it('should emit worker:error event', () => {
      const onEvent = vi.fn();
      pool.onEvent(onEvent);

      pool.createWorker({ id: 'w1' });
      pool.disableWorker('w1');

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'worker:error', workerId: 'w1' })
      );
    });

    it('should do nothing for non-existent worker', () => {
      expect(() => pool.disableWorker('nonexistent')).not.toThrow();
    });
  });

  describe('disposeWorker', () => {
    it('should remove idle worker from pool', () => {
      pool.createWorker({ id: 'w1' });
      pool.disposeWorker('w1');

      expect(pool.getWorker('w1')).toBeUndefined();
    });

    it('should emit worker:disposed event', () => {
      const onEvent = vi.fn();
      pool.onEvent(onEvent);

      pool.createWorker({ id: 'w1' });
      pool.disposeWorker('w1');

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'worker:disposed', workerId: 'w1' })
      );
    });

    it('should mark worker as disabled if it has running tasks', () => {
      const worker = pool.createWorker({ id: 'w1' });
      // Simulate a running task
      worker.currentTaskIds.push('task-1');
      pool.disposeWorker('w1');

      // Worker should be disabled but not removed
      expect(pool.getWorker('w1')).toBeDefined();
      expect(pool.getWorker('w1')?.status).toBe('disabled');
    });

    it('should do nothing for non-existent worker', () => {
      expect(() => pool.disposeWorker('nonexistent')).not.toThrow();
    });
  });

  describe('onEvent', () => {
    it('should call callback on events', () => {
      const callback = vi.fn();
      pool.onEvent(callback);

      pool.createWorker();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = pool.onEvent(callback);

      pool.createWorker();
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      pool.createWorker();
      expect(callback).toHaveBeenCalledTimes(1); // No new calls
    });

    it('should support multiple subscribers', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      pool.onEvent(cb1);
      pool.onEvent(cb2);

      pool.createWorker();

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('should not propagate errors from callbacks', () => {
      const badCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      const goodCallback = vi.fn();

      pool.onEvent(badCallback);
      pool.onEvent(goodCallback);

      expect(() => pool.createWorker()).not.toThrow();
      expect(goodCallback).toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    it('should enqueue a task', () => {
      // Mock the agent factory to prevent actual execution
      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      const task = pool.submit({
        id: 'task-1',
        name: 'Test task',
        prompt: 'Do something',
        chatId: 'chat-1',
        callbacks,
      });

      expect(task).toBeDefined();
      expect(task.name).toBe('Test task');
    });

    it('should emit task:queued event', () => {
      const onEvent = vi.fn();
      pool.onEvent(onEvent);

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      pool.submit({
        id: 'task-1',
        name: 'Test task',
        prompt: 'Do something',
        chatId: 'chat-1',
        callbacks,
      });

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task:queued' })
      );
    });
  });

  describe('submitBatch', () => {
    it('should submit multiple tasks', () => {
      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as any);

      const tasks = pool.submitBatch([
        { id: 't1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks },
        { id: 't2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks },
      ]);

      expect(tasks).toHaveLength(2);
      expect(tasks[0].name).toBe('Task 1');
      expect(tasks[1].name).toBe('Task 2');
    });
  });

  describe('getStats', () => {
    it('should return empty stats for new pool', () => {
      const stats = pool.getStats();
      expect(stats).toEqual({
        totalWorkers: 0,
        idleWorkers: 0,
        busyWorkers: 0,
        pendingTasks: 0,
        runningTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
      });
    });

    it('should reflect created workers', () => {
      pool.createWorker({ id: 'w1' });
      pool.createWorker({ id: 'w2' });

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(2);
      expect(stats.idleWorkers).toBe(2);
    });

    it('should reflect disabled workers', () => {
      pool.createWorker({ id: 'w1' });
      pool.createWorker({ id: 'w2' });
      pool.disableWorker('w1');

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(2);
      expect(stats.idleWorkers).toBe(1);
    });
  });

  describe('getPendingTasks', () => {
    it('should return empty array initially', () => {
      expect(pool.getPendingTasks()).toEqual([]);
    });

    it('should return tasks that exceed worker capacity', () => {
      // Use slow mock so tasks stay in the queue
      const slowPromise = new Promise(() => {}); // never resolves
      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockReturnValue(slowPromise),
        dispose: vi.fn(),
      } as any);

      // Submit more tasks than maxWorkers (3)
      for (let i = 0; i < 5; i++) {
        pool.submit({
          id: `task-pending-${i}`,
          name: `Pending Task ${i}`,
          prompt: 'Test',
          chatId: `chat-${i}`,
          callbacks,
        });
      }

      const pending = pool.getPendingTasks();
      // At least 2 should still be pending (5 tasks - 3 maxWorkers)
      expect(pending.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getRunningTasks', () => {
    it('should return empty array initially', () => {
      expect(pool.getRunningTasks()).toEqual([]);
    });

    it('should return running tasks when assigned to workers', () => {
      // Create a worker so the task can be assigned immediately
      pool.createWorker({ id: 'w1' });

      // Use a mock that doesn't resolve immediately to keep task running
      let resolveExecution: () => void;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockReturnValue(executionPromise),
        dispose: vi.fn(),
      } as any);

      pool.submit({
        id: 'task-running-1',
        name: 'Running Task',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks,
      });

      const running = pool.getRunningTasks();
      expect(running).toHaveLength(1);
      expect(running[0].name).toBe('Running Task');

      // Cleanup: resolve the pending promise
      resolveExecution!();
    });
  });

  describe('getQueueSize', () => {
    it('should return 0 initially', () => {
      expect(pool.getQueueSize()).toBe(0);
    });

    it('should increase when tasks exceed worker capacity', () => {
      // Use slow mock to keep tasks active
      const slowPromise = new Promise(() => {});
      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockReturnValue(slowPromise),
        dispose: vi.fn(),
      } as any);

      // Submit more tasks than maxWorkers (3)
      for (let i = 0; i < 5; i++) {
        pool.submit({
          id: `task-q-${i}`,
          name: `Queue Task ${i}`,
          prompt: 'Test',
          chatId: `chat-${i}`,
          callbacks,
        });
      }

      // At least 2 should remain in the pending queue (5 - 3 workers)
      expect(pool.getQueueSize()).toBeGreaterThanOrEqual(2);
    });
  });

  describe('cancelTask', () => {
    it('should return false for non-existent task', () => {
      expect(pool.cancelTask('nonexistent')).toBe(false);
    });

    it('should cancel a pending task that exceeds worker capacity', () => {
      // Use slow mock so tasks remain in the queue
      const slowPromise = new Promise(() => {});
      mockAgentFactory.createAgent.mockReturnValue({
        executeOnce: vi.fn().mockReturnValue(slowPromise),
        dispose: vi.fn(),
      } as any);

      // Fill up all workers (3) then submit one more that stays pending
      for (let i = 0; i < 3; i++) {
        pool.submit({
          id: `task-fill-${i}`,
          name: `Fill Task ${i}`,
          prompt: 'Test',
          chatId: `chat-fill-${i}`,
          callbacks,
        });
      }

      pool.submit({
        id: 'task-cancel-1',
        name: 'Cancellable Task',
        prompt: 'Test',
        chatId: 'chat-cancel',
        callbacks,
      });

      // The 4th task should be pending and cancellable
      const result = pool.cancelTask('task-cancel-1');
      expect(result).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should clear all workers and events', () => {
      pool.createWorker({ id: 'w1' });
      pool.createWorker({ id: 'w2' });

      const onEvent = vi.fn();
      pool.onEvent(onEvent);

      pool.dispose();

      expect(pool.getAllWorkers()).toHaveLength(0);
      expect(pool.getQueueSize()).toBe(0);
    });

    it('should be safe to call dispose multiple times', () => {
      pool.createWorker({ id: 'w1' });
      pool.dispose();
      pool.dispose(); // Should not throw

      expect(pool.getAllWorkers()).toHaveLength(0);
    });
  });
});
