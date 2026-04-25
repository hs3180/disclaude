/**
 * Tests for Worker Pool Worker Management functions.
 *
 * Covers:
 * - createWorkerHandle: worker creation with defaults and custom options
 * - findIdleWorker: finding first idle worker
 * - getIdleWorkers: getting all idle workers
 * - updateWorkerStatus: status transitions and event emission
 * - ensureMinIdleWorkers: maintaining minimum idle worker count
 *
 * @see Issue #1617 Phase 3
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createWorkerHandle,
  findIdleWorker,
  getIdleWorkers,
  updateWorkerStatus,
  ensureMinIdleWorkers,
  type WorkerMgmtContext,
} from './worker-pool-worker-mgmt.js';
import type { WorkerHandle } from './types.js';

function createMgmtContext(): WorkerMgmtContext {
  return {
    config: {
      maxWorkers: 5,
      minIdleWorkers: 1,
      defaultTimeout: 300000,
      maxRetries: 2,
      enablePriority: true,
      maxHistorySize: 100,
      resultRetentionTime: 3600000,
    },
    emit: vi.fn(),
  };
}

describe('createWorkerHandle', () => {
  it('should create a worker with default values', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers);

    expect(handle.id).toMatch(/^worker-[0-9a-f]{8}$/);
    expect(handle.type).toBe('general');
    expect(handle.status).toBe('idle');
    expect(handle.currentTaskIds).toEqual([]);
    expect(handle.createdAt).toBeInstanceOf(Date);
    expect(handle.stats).toEqual({
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    });
    expect(handle.maxConcurrent).toBe(1);
    expect(handle.defaultTimeout).toBe(300000);
  });

  it('should register the worker in the workers map', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers);

    expect(workers.has(handle.id)).toBe(true);
    expect(workers.get(handle.id)).toBe(handle);
  });

  it('should emit worker:created event', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    createWorkerHandle(ctx, workers);

    expect(ctx.emit).toHaveBeenCalledWith('worker:created', {
      workerId: expect.any(String),
    });
  });

  it('should use custom id when provided', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers, { id: 'custom-id' });

    expect(handle.id).toBe('custom-id');
  });

  it('should use custom type when provided', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers, { type: 'skill' });

    expect(handle.type).toBe('skill');
  });

  it('should use custom skillName when provided', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers, { skillName: 'my-skill' });

    expect(handle.skillName).toBe('my-skill');
  });

  it('should use custom maxConcurrent when provided', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers, { maxConcurrent: 4 });

    expect(handle.maxConcurrent).toBe(4);
  });

  it('should use custom defaultTimeout when provided', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const handle = createWorkerHandle(ctx, workers, { defaultTimeout: 60000 });

    expect(handle.defaultTimeout).toBe(60000);
  });

  it('should create multiple workers with unique IDs', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    const h1 = createWorkerHandle(ctx, workers);
    const h2 = createWorkerHandle(ctx, workers);

    expect(h1.id).not.toBe(h2.id);
    expect(workers.size).toBe(2);
  });
});

describe('findIdleWorker', () => {
  it('should return undefined when no workers exist', () => {
    const workers = new Map<string, WorkerHandle>();

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should return undefined when all workers are busy', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w1', {
      id: 'w1', type: 'general', status: 'busy',
      currentTaskIds: ['t1'], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should return the first idle worker', () => {
    const workers = new Map<string, WorkerHandle>();
    const idleWorker: WorkerHandle = {
      id: 'w2', type: 'general', status: 'idle',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', {
      id: 'w1', type: 'general', status: 'busy',
      currentTaskIds: ['t1'], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });
    workers.set('w2', idleWorker);

    expect(findIdleWorker(workers)).toBe(idleWorker);
  });

  it('should skip workers with error status', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w1', {
      id: 'w1', type: 'general', status: 'error',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should skip workers with disabled status', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w1', {
      id: 'w1', type: 'general', status: 'disabled',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    expect(findIdleWorker(workers)).toBeUndefined();
  });
});

describe('getIdleWorkers', () => {
  it('should return empty array when no workers', () => {
    const workers = new Map<string, WorkerHandle>();
    expect(getIdleWorkers(workers)).toEqual([]);
  });

  it('should return only idle workers', () => {
    const workers = new Map<string, WorkerHandle>();
    const idle1: WorkerHandle = {
      id: 'w1', type: 'general', status: 'idle',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    const idle2: WorkerHandle = {
      id: 'w2', type: 'general', status: 'idle',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', idle1);
    workers.set('w2', idle2);
    workers.set('w3', {
      id: 'w3', type: 'general', status: 'busy',
      currentTaskIds: ['t1'], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    const result = getIdleWorkers(workers);
    expect(result).toHaveLength(2);
    expect(result).toContain(idle1);
    expect(result).toContain(idle2);
  });
});

describe('updateWorkerStatus', () => {
  it('should update worker status to idle', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker: WorkerHandle = {
      id: 'w1', type: 'general', status: 'busy',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', worker);
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w1', 'idle', emit);

    expect(worker.status).toBe('idle');
    expect(worker.stats.lastActivityAt).toBeInstanceOf(Date);
    expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: 'w1' });
  });

  it('should update worker status to busy', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker: WorkerHandle = {
      id: 'w1', type: 'general', status: 'idle',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', worker);
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w1', 'busy', emit);

    expect(worker.status).toBe('busy');
    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
  });

  it('should update worker status to error', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker: WorkerHandle = {
      id: 'w1', type: 'general', status: 'busy',
      currentTaskIds: [], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', worker);
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w1', 'error', emit);

    expect(worker.status).toBe('error');
    // 'error' is not 'idle', so should emit 'worker:busy'
    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
  });

  it('should do nothing when worker does not exist', () => {
    const workers = new Map<string, WorkerHandle>();
    const emit = vi.fn();

    updateWorkerStatus(workers, 'nonexistent', 'idle', emit);

    expect(emit).not.toHaveBeenCalled();
  });
});

describe('ensureMinIdleWorkers', () => {
  it('should create workers when below minimum', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    ensureMinIdleWorkers(ctx, workers, 3);

    expect(workers.size).toBe(3);
    for (const worker of workers.values()) {
      expect(worker.status).toBe('idle');
      expect(worker.type).toBe('general');
    }
  });

  it('should not create workers when already at minimum', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();
    createWorkerHandle(ctx, workers);

    const sizeBefore = workers.size;
    ensureMinIdleWorkers(ctx, workers, 1);

    expect(workers.size).toBe(sizeBefore);
  });

  it('should not create workers when above minimum', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();
    createWorkerHandle(ctx, workers);
    createWorkerHandle(ctx, workers);
    createWorkerHandle(ctx, workers);

    const sizeBefore = workers.size;
    ensureMinIdleWorkers(ctx, workers, 2);

    expect(workers.size).toBe(sizeBefore);
  });

  it('should only count idle workers, not busy ones', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    // Create one busy worker manually
    const busyWorker: WorkerHandle = {
      id: 'busy-1', type: 'general', status: 'busy',
      currentTaskIds: ['t1'], createdAt: new Date(),
      maxConcurrent: 1, defaultTimeout: 300000,
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('busy-1', busyWorker);

    ensureMinIdleWorkers(ctx, workers, 2);

    // Should create 2 idle workers (busy-1 doesn't count)
    const idleCount = getIdleWorkers(workers).length;
    expect(idleCount).toBe(2);
    expect(workers.size).toBe(3); // 1 busy + 2 new idle
  });

  it('should create zero workers when minIdle is 0', () => {
    const ctx = createMgmtContext();
    const workers = new Map<string, WorkerHandle>();

    ensureMinIdleWorkers(ctx, workers, 0);

    expect(workers.size).toBe(0);
  });
});
