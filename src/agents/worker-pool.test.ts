/**
 * Tests for WorkerPool - Worker pool management for parallel task execution.
 *
 * Issue #897 Phase 1: Worker Pool Management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from './worker-pool.js';
import type { SubTask, Worker } from './worker-types.js';

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

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new WorkerPool({ maxWorkers: 3 });
  });

  afterEach(() => {
    pool.dispose();
  });

  describe('constructor', () => {
    it('should create pool with default config', () => {
      const defaultPool = new WorkerPool();
      const stats = defaultPool.getStats();
      expect(stats.totalWorkers).toBe(0);
      defaultPool.dispose();
    });

    it('should create pool with custom config', () => {
      const customPool = new WorkerPool({
        maxWorkers: 5,
        maxConcurrent: 3,
        taskTimeout: 60000,
        autoDispose: true,
      });
      expect(customPool).toBeDefined();
      customPool.dispose();
    });
  });

  describe('getStats', () => {
    it('should return correct initial stats', () => {
      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(0);
      expect(stats.idleWorkers).toBe(0);
      expect(stats.busyWorkers).toBe(0);
      expect(stats.pendingTasks).toBe(0);
      expect(stats.completedTasks).toBe(0);
      expect(stats.failedTasks).toBe(0);
    });
  });

  describe('acquire', () => {
    it('should create and return a worker on first acquire', async () => {
      const worker = await pool.acquire();
      expect(worker).toBeDefined();
      expect(worker?.status).toBe('busy');
      expect(worker?.id).toMatch(/^worker-/);

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(1);
      expect(stats.busyWorkers).toBe(1);
    });

    it('should return idle worker if available', async () => {
      const worker1 = await pool.acquire();
      expect(worker1).toBeDefined();
      pool.release(worker1!);

      const worker2 = await pool.acquire();
      expect(worker2).toBeDefined();
      expect(worker2?.id).toBe(worker1?.id);
      expect(worker2?.status).toBe('busy');
    });

    it('should return undefined when pool is at capacity', async () => {
      const smallPool = new WorkerPool({ maxWorkers: 1 });
      const worker1 = await smallPool.acquire();
      const worker2 = await smallPool.acquire();

      expect(worker1).toBeDefined();
      expect(worker2).toBeUndefined();

      smallPool.dispose();
    });
  });

  describe('release', () => {
    it('should mark worker as idle', async () => {
      const worker = await pool.acquire();
      expect(worker?.status).toBe('busy');

      pool.release(worker!);

      const stats = pool.getStats();
      expect(stats.idleWorkers).toBe(1);
      expect(stats.busyWorkers).toBe(0);
    });

    it('should handle unknown worker gracefully', () => {
      const fakeWorker: Worker = {
        id: 'unknown-worker',
        type: 'general',
        status: 'busy',
        agent: {} as any,
      };

      expect(() => pool.release(fakeWorker)).not.toThrow();
    });
  });

  describe('executeTask', () => {
    it('should execute a task and return result', async () => {
      const task: SubTask = {
        id: 'task-1',
        prompt: 'Test task',
      };

      const result = await pool.executeTask(task);

      expect(result.taskId).toBe('task-1');
      expect(result.success).toBe(true);
      expect(result.content).toBe('test result');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('should increment completed tasks counter on success', async () => {
      const task: SubTask = {
        id: 'task-1',
        prompt: 'Test task',
      };

      await pool.executeTask(task);

      const stats = pool.getStats();
      expect(stats.completedTasks).toBe(1);
    });

    it('should return failure result when no workers available', async () => {
      const smallPool = new WorkerPool({ maxWorkers: 1 });
      await smallPool.acquire(); // Occupy the only worker

      const task: SubTask = {
        id: 'task-2',
        prompt: 'Test task',
      };

      const result = await smallPool.executeTask(task);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No workers available');

      smallPool.dispose();
    });
  });

  describe('executeAll', () => {
    it('should execute multiple tasks', async () => {
      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
      ];

      const results = await pool.executeAll(tasks);

      expect(results).toHaveLength(2);
      expect(results[0].taskId).toBe('task-1');
      expect(results[1].taskId).toBe('task-2');
    });

    it('should respect maxConcurrent limit', async () => {
      const limitedPool = new WorkerPool({ maxWorkers: 3, maxConcurrent: 2 });

      const tasks: SubTask[] = [
        { id: 'task-1', prompt: 'Task 1' },
        { id: 'task-2', prompt: 'Task 2' },
        { id: 'task-3', prompt: 'Task 3' },
      ];

      const results = await limitedPool.executeAll(tasks);

      expect(results).toHaveLength(3);
      limitedPool.dispose();
    });
  });

  describe('getWorker', () => {
    it('should return worker by id', async () => {
      const worker = await pool.acquire();
      const found = pool.getWorker(worker!.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(worker?.id);
    });

    it('should return undefined for unknown worker', () => {
      const found = pool.getWorker('unknown-id');
      expect(found).toBeUndefined();
    });
  });

  describe('getWorkers', () => {
    it('should return all workers', async () => {
      await pool.acquire();
      await pool.acquire();

      const workers = pool.getWorkers();
      expect(workers).toHaveLength(2);
    });
  });

  describe('getIdleWorkers', () => {
    it('should return only idle workers', async () => {
      const worker1 = await pool.acquire();
      await pool.acquire(); // Occupy second worker
      pool.release(worker1!);

      const idleWorkers = pool.getIdleWorkers();
      expect(idleWorkers).toHaveLength(1);
      expect(idleWorkers[0].id).toBe(worker1?.id);
    });
  });

  describe('getBusyWorkers', () => {
    it('should return only busy workers', async () => {
      const worker1 = await pool.acquire();
      const worker2 = await pool.acquire();
      pool.release(worker1!);

      const busyWorkers = pool.getBusyWorkers();
      expect(busyWorkers).toHaveLength(1);
      expect(busyWorkers[0].id).toBe(worker2?.id);
    });
  });

  describe('dispose', () => {
    it('should dispose all workers', async () => {
      await pool.acquire();
      await pool.acquire();

      pool.dispose();

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(0);
    });

    it('should be idempotent', () => {
      pool.dispose();
      pool.dispose(); // Should not throw
    });

    it('should throw error when trying to acquire after dispose', async () => {
      pool.dispose();

      await expect(pool.acquire()).rejects.toThrow('WorkerPool has been disposed');
    });
  });
});
