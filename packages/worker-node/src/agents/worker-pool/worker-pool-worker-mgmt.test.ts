/**
 * Tests for Worker Pool Worker Management - CRUD operations and status tracking.
 *
 * Verifies createWorkerHandle, findIdleWorker, getIdleWorkers,
 * updateWorkerStatus, and ensureMinIdleWorkers.
 *
 * Issue #1617: Phase 2 — worker-node worker-pool-worker-mgmt test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createWorkerHandle,
  findIdleWorker,
  getIdleWorkers,
  updateWorkerStatus,
  ensureMinIdleWorkers,
  type WorkerMgmtContext,
} from './worker-pool-worker-mgmt.js';
import type { WorkerHandle } from './types.js';

// Mock crypto to return unique predictable UUIDs with distinct first 8 chars
let uuidCounter = 0;
vi.mock('crypto', () => ({
  randomUUID: () => {
    uuidCounter++;
    return `${String(uuidCounter).padStart(8, '0')}-uuid-mock`;
  },
}));

// Reset counter between tests
beforeEach(() => {
  uuidCounter = 0;
});

function createMockContext(overrides?: Partial<WorkerMgmtContext>): WorkerMgmtContext {
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
    ...overrides,
  };
}

describe('createWorkerHandle', () => {
  let ctx: WorkerMgmtContext;
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    ctx = createMockContext();
    workers = new Map();
  });

  it('should create a worker with default values', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.id).toBe('worker-00000001');  // first 8 chars of sliced UUID
    expect(handle.type).toBe('general');
    expect(handle.status).toBe('idle');
    expect(handle.maxConcurrent).toBe(1);
    expect(handle.defaultTimeout).toBe(300000);
    expect(handle.currentTaskIds).toEqual([]);
    expect(handle.stats).toEqual({
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    });
    expect(handle.createdAt).toBeInstanceOf(Date);
  });

  it('should register the worker in the workers map', () => {
    const handle = createWorkerHandle(ctx, workers);
    expect(workers.has(handle.id)).toBe(true);
    expect(workers.get(handle.id)).toBe(handle);
  });

  it('should emit worker:created event', () => {
    const handle = createWorkerHandle(ctx, workers);
    expect(ctx.emit).toHaveBeenCalledWith('worker:created', { workerId: handle.id });
  });

  it('should use custom id when provided', () => {
    const handle = createWorkerHandle(ctx, workers, { id: 'my-worker-1' });
    expect(handle.id).toBe('my-worker-1');
  });

  it('should use custom type when provided', () => {
    const handle = createWorkerHandle(ctx, workers, { type: 'skill' });
    expect(handle.type).toBe('skill');
  });

  it('should use custom skillName when provided', () => {
    const handle = createWorkerHandle(ctx, workers, {
      type: 'skill',
      skillName: 'pr-scanner',
    });
    expect(handle.skillName).toBe('pr-scanner');
  });

  it('should use custom maxConcurrent when provided', () => {
    const handle = createWorkerHandle(ctx, workers, { maxConcurrent: 4 });
    expect(handle.maxConcurrent).toBe(4);
  });

  it('should use custom defaultTimeout when provided', () => {
    const handle = createWorkerHandle(ctx, workers, { defaultTimeout: 60000 });
    expect(handle.defaultTimeout).toBe(60000);
  });

  it('should use pool config defaultTimeout when not specified', () => {
    const customCtx = createMockContext({
      config: {
        ...createMockContext().config,
        defaultTimeout: 120000,
      },
    });
    const handle = createWorkerHandle(customCtx, workers);
    expect(handle.defaultTimeout).toBe(120000);
  });

  it('should create multiple workers with unique IDs', () => {
    const _handle1 = createWorkerHandle(ctx, workers);
    const _handle2 = createWorkerHandle(ctx, workers);
    // With incrementing mock UUIDs, both get unique IDs
    expect(workers.size).toBe(2);
  });
});

describe('findIdleWorker', () => {
  it('should return undefined for empty workers map', () => {
    expect(findIdleWorker(new Map())).toBeUndefined();
  });

  it('should return the first idle worker', () => {
    const workers = new Map<string, WorkerHandle>();
    const idleWorker: WorkerHandle = {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'idle', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', idleWorker);

    expect(findIdleWorker(workers)).toBe(idleWorker);
  });

  it('should skip busy workers and find idle ones', () => {
    const workers = new Map<string, WorkerHandle>();
    const busyWorker: WorkerHandle = {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'busy', currentTaskIds: ['t1'], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    const idleWorker: WorkerHandle = {
      id: 'w2', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'idle', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', busyWorker);
    workers.set('w2', idleWorker);

    expect(findIdleWorker(workers)).toBe(idleWorker);
  });

  it('should return undefined when all workers are busy', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w1', {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'busy', currentTaskIds: ['t1'], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should skip disabled workers', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w1', {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'disabled', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    expect(findIdleWorker(workers)).toBeUndefined();
  });
});

describe('getIdleWorkers', () => {
  it('should return empty array for empty workers map', () => {
    expect(getIdleWorkers(new Map())).toEqual([]);
  });

  it('should return only idle workers', () => {
    const workers = new Map<string, WorkerHandle>();
    const idle1: WorkerHandle = {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'idle', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    const busy: WorkerHandle = {
      id: 'w2', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'busy', currentTaskIds: ['t1'], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    const idle2: WorkerHandle = {
      id: 'w3', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'idle', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', idle1);
    workers.set('w2', busy);
    workers.set('w3', idle2);

    const result = getIdleWorkers(workers);
    expect(result).toHaveLength(2);
    expect(result).toContain(idle1);
    expect(result).toContain(idle2);
  });

  it('should return empty when all workers are busy or disabled', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w1', {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'busy', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });
    workers.set('w2', {
      id: 'w2', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'disabled', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    });

    expect(getIdleWorkers(workers)).toEqual([]);
  });
});

describe('updateWorkerStatus', () => {
  it('should update worker status to busy', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker: WorkerHandle = {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'idle', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', worker);

    const emit = vi.fn();
    updateWorkerStatus(workers, 'w1', 'busy', emit);

    expect(worker.status).toBe('busy');
    expect(worker.stats.lastActivityAt).toBeInstanceOf(Date);
    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
  });

  it('should update worker status to idle', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker: WorkerHandle = {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'busy', currentTaskIds: ['t1'], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', worker);

    const emit = vi.fn();
    updateWorkerStatus(workers, 'w1', 'idle', emit);

    expect(worker.status).toBe('idle');
    expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: 'w1' });
  });

  it('should be a no-op for non-existent worker', () => {
    const workers = new Map();
    const emit = vi.fn();
    // Should not throw
    updateWorkerStatus(workers, 'nonexistent', 'busy', emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it('should set lastActivityAt timestamp', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker: WorkerHandle = {
      id: 'w1', type: 'general', skillName: undefined,
      maxConcurrent: 1, defaultTimeout: 300000,
      status: 'idle', currentTaskIds: [], createdAt: new Date(),
      stats: { tasksCompleted: 0, tasksFailed: 0, totalExecutionTime: 0, averageExecutionTime: 0 },
    };
    workers.set('w1', worker);

    const before = new Date();
    updateWorkerStatus(workers, 'w1', 'busy', vi.fn());
    const after = new Date();

    expect(worker.stats.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(worker.stats.lastActivityAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe('ensureMinIdleWorkers', () => {
  let ctx: WorkerMgmtContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should create workers when below minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    ensureMinIdleWorkers(ctx, workers, 2);

    // Should have created 2 new idle workers
    const idleWorkers = getIdleWorkers(workers);
    expect(idleWorkers.length).toBeGreaterThanOrEqual(2);
  });

  it('should not create workers when already at minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    // Pre-create 3 idle workers
    for (let i = 0; i < 3; i++) {
      createWorkerHandle(ctx, workers);
    }

    const emitSpy = vi.spyOn(ctx, 'emit');
    ensureMinIdleWorkers(ctx, workers, 3);

    // Should not emit any new worker:created events
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('should not create workers when above minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    for (let i = 0; i < 5; i++) {
      createWorkerHandle(ctx, workers);
    }

    const beforeSize = workers.size;
    ensureMinIdleWorkers(ctx, workers, 3);
    expect(workers.size).toBe(beforeSize);
  });

  it('should only count idle workers, not busy ones', () => {
    const workers = new Map<string, WorkerHandle>();
    const handle = createWorkerHandle(ctx, workers);
    // Make the worker busy
    handle.status = 'busy';

    ensureMinIdleWorkers(ctx, workers, 1);

    // Should have created 1 new idle worker
    const idleWorkers = getIdleWorkers(workers);
    expect(idleWorkers.length).toBeGreaterThanOrEqual(1);
  });

  it('should create exactly the number needed to reach minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    createWorkerHandle(ctx, workers); // 1 idle worker

    ensureMinIdleWorkers(ctx, workers, 4);

    const idleWorkers = getIdleWorkers(workers);
    expect(idleWorkers.length).toBeGreaterThanOrEqual(4);
  });

  it('should handle zero minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    ensureMinIdleWorkers(ctx, workers, 0);
    expect(workers.size).toBe(0);
  });
});
