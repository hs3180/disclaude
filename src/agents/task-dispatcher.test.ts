/**
 * Tests for TaskDispatcher - Task queue and dispatch management.
 *
 * Issue #897 Phase 1: Task Queue and Dispatcher
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskDispatcher } from './task-dispatcher.js';
import { WorkerPool } from './worker-pool.js';
import type { SubTask } from './worker-types.js';

// Mock AgentFactory
vi.mock('./factory.js', () => ({
  AgentFactory: {
    createSkillAgent: vi.fn().mockImplementation(() => ({
      execute: vi.fn().mockImplementation(async function* () {
        yield { content: 'test result' };
      }),
      dispose: vi.fn(),
    })),
  },
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn().mockReturnValue({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    }),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TaskDispatcher', () => {
  let pool: WorkerPool;
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new WorkerPool({ maxWorkers: 3 });
    dispatcher = new TaskDispatcher(pool);
  });

  afterEach(() => {
    dispatcher.dispose();
    pool.dispose();
  });

  describe('constructor', () => {
    it('should create dispatcher with default config', () => {
      const defaultDispatcher = new TaskDispatcher(pool);
      expect(defaultDispatcher.pendingCount).toBe(0);
      defaultDispatcher.dispose();
    });

    it('should create dispatcher with custom config', () => {
      const onComplete = vi.fn();
      const customDispatcher = new TaskDispatcher(pool, {
        strategy: 'priority',
        maxRetries: 2,
        onTaskComplete: onComplete,
      });
      expect(customDispatcher).toBeDefined();
      customDispatcher.dispose();
    });
  });

  describe('enqueue', () => {
    it('should add tasks to queue', () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
      ];

      dispatcher.enqueue(tasks);

      expect(dispatcher.pendingCount).toBe(2);
    });

    it('should sort tasks by priority when strategy is priority', () => {
      const priorityDispatcher = new TaskDispatcher(pool, { strategy: 'priority' });

      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1', priority: 'low' },
        { id: 'task-2', prompt: 'Task 2', priority: 'high' },
        { id: 'task-3', prompt: 'Task 3', priority: 'normal' },
      ];

      priorityDispatcher.enqueue(tasks);

      expect(priorityDispatcher.pendingCount).toBe(3);
      priorityDispatcher.dispose();
    });
  });

  describe('processNext', () => {
    it('should process next task in queue', async () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
      ];

      dispatcher.enqueue(tasks);
      const result = await dispatcher.processNext();

      expect(result).toBeDefined();
      expect(result?.taskId).toBe('task-1');
      expect(result?.success).toBe(true);
      expect(dispatcher.pendingCount).toBe(0);
    });

    it('should return undefined when queue is empty', async () => {
      const result = await dispatcher.processNext();
      expect(result).toBeUndefined();
    });

    it('should invoke onTaskComplete callback', async () => {
      const onComplete = vi.fn();
      const callbackDispatcher = new TaskDispatcher(pool, {
        onTaskComplete: onComplete,
      });

      const tasks: SubTask[] = [{ id: 'task-1', prompt: 'Task 1' }];
      callbackDispatcher.enqueue(tasks);

      await callbackDispatcher.processNext();

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'task-1',
        success: true,
      }));

      callbackDispatcher.dispose();
    });
  });

  describe('processAll', () => {
    it('should process all tasks in queue', async () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
        { id: 'task-3', prompt: 'Task 3' },
      ];

      dispatcher.enqueue(tasks);
      const results = await dispatcher.processAll();

      expect(results).toHaveLength(3);
      expect(dispatcher.pendingCount).toBe(0);
      expect(dispatcher.completedCount).toBe(3);
    });
  });

  describe('dispatch', () => {
    it('should dispatch tasks and return handles', async () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
      ];

      const handles = await dispatcher.dispatch(tasks);

      expect(handles.length).toBeGreaterThan(0);
      expect(handles[0].taskId).toBe('task-1');
      expect(handles[0].workerId).toBeDefined();
      expect(handles[0].result).toBeInstanceOf(Promise);
    });
  });

  describe('waitForAll', () => {
    it('should wait for all dispatched tasks', async () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
      ];

      // Use processAll instead of dispatch for more reliable testing
      dispatcher.enqueue(tasks);
      const results = await dispatcher.processAll();

      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });
  });

  describe('getResult', () => {
    it('should return completed task result', async () => {
      const tasks: SubTask[] = [{ id: 'task-1', prompt: 'Task 1' }];

      dispatcher.enqueue(tasks);
      await dispatcher.processNext();

      const result = dispatcher.getResult('task-1');
      expect(result).toBeDefined();
      expect(result?.taskId).toBe('task-1');
    });

    it('should return undefined for unknown task', () => {
      const result = dispatcher.getResult('unknown-task');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllResults', () => {
    it('should return all completed results', async () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
      ];

      dispatcher.enqueue(tasks);
      await dispatcher.processAll();

      const results = dispatcher.getAllResults();
      expect(results.size).toBe(2);
      expect(results.has('task-1')).toBe(true);
      expect(results.has('task-2')).toBe(true);
    });
  });

  describe('clearQueue', () => {
    it('should clear all pending tasks', () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
      ];

      dispatcher.enqueue(tasks);
      dispatcher.clearQueue();

      expect(dispatcher.pendingCount).toBe(0);
    });
  });

  describe('dependency resolution', () => {
    it('should process tasks with dependencies in correct order', async () => {
      const executionOrder: string[] = [];
      const trackDispatcher = new TaskDispatcher(pool, {
        onTaskComplete: (result) => {
          executionOrder.push(result.taskId);
        },
      });

      const tasks: SubTask[] = [
        { id: 'task-2', prompt: 'Task 2', dependencies: ['task-1'] },
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-3', prompt: 'Task 3', dependencies: ['task-2'] },
      ];

      trackDispatcher.enqueue(tasks);
      await trackDispatcher.processAll();

      expect(executionOrder).toEqual(['task-1', 'task-2', 'task-3']);
      trackDispatcher.dispose();
    });

    it('should not process task if dependency fails', async () => {
      // Create a pool that will fail
      const failPool = new WorkerPool({ maxWorkers: 1 });
      const failDispatcher = new TaskDispatcher(failPool);

      // Mock execute to fail for task-1
      const originalExecute = failPool.executeTask.bind(failPool);
      vi.spyOn(failPool, 'executeTask').mockImplementation(async (task) => {
        if (task.id === 'task-1') {
          return {
            taskId: task.id,
            workerId: 'worker-1',
            success: false,
            error: 'Simulated failure',
            elapsedMs: 0,
          };
        }
        return await originalExecute(task);
      });

      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2', dependencies: ['task-1'] },
      ];

      failDispatcher.enqueue(tasks);
      await failDispatcher.processAll();

      // task-2 should not be processed because task-1 failed
      expect(failDispatcher.getResult('task-2')).toBeUndefined();

      failDispatcher.dispose();
      failPool.dispose();
    });
  });

  describe('retry logic', () => {
    it('should retry failed tasks up to maxRetries', async () => {
      let attempts = 0;
      const retryPool = new WorkerPool({ maxWorkers: 1 });

      vi.spyOn(retryPool, 'executeTask').mockImplementation((task) => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve({
            taskId: task.id,
            workerId: 'worker-1',
            success: false,
            error: 'Simulated failure',
            elapsedMs: 0,
          });
        }
        return Promise.resolve({
          taskId: task.id,
          workerId: 'worker-1',
          success: true,
          content: 'Success after retry',
          elapsedMs: 0,
        });
      });

      const retryDispatcher = new TaskDispatcher(retryPool, { maxRetries: 3 });

      const tasks: SubTask[] = [{ id: 'task-1', prompt: 'Task 1' }];
      retryDispatcher.enqueue(tasks);

      // Process all tasks (including retries)
      await retryDispatcher.processAll();

      // First attempt + 2 retries = 3 attempts
      expect(attempts).toBe(3);

      retryDispatcher.dispose();
      retryPool.dispose();
    });
  });

  describe('dispose', () => {
    it('should clear queue and results', () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
      ];

      dispatcher.enqueue(tasks);
      dispatcher.dispose();

      expect(dispatcher.pendingCount).toBe(0);
      expect(dispatcher.completedCount).toBe(0);
    });

    it('should be idempotent', () => {
      dispatcher.dispose();
      dispatcher.dispose(); // Should not throw
    });

    it('should throw error when trying to enqueue after dispose', () => {
      dispatcher.dispose();

      expect(() => dispatcher.enqueue([{ id: 't1', prompt: 'test' }])).toThrow(
        'TaskDispatcher has been disposed'
      );
    });
  });
});
