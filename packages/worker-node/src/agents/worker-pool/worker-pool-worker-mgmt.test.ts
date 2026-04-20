/**
 * Tests for Worker Pool Worker Management - Worker CRUD and status tracking.
 *
 * Issue #1617 Phase 2: Add meaningful unit tests for worker-pool modules.
 * Covers createWorkerHandle, findIdleWorker, getIdleWorkers,
 * updateWorkerStatus, and ensureMinIdleWorkers.
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

// ============================================================================
// Helpers
// ============================================================================

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

function createWorker(overrides: Partial<WorkerHandle> = {}): WorkerHandle {
  return {
    id: overrides.id ?? 'worker-test',
    type: overrides.type ?? 'general',
    skillName: overrides.skillName,
    maxConcurrent: overrides.maxConcurrent ?? 1,
    defaultTimeout: overrides.defaultTimeout ?? 300000,
    status: overrides.status ?? 'idle',
    currentTaskIds: overrides.currentTaskIds ?? [],
    createdAt: overrides.createdAt ?? new Date(),
    stats: overrides.stats ?? {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    },
  };
}

// ============================================================================
// Tests: createWorkerHandle
// ============================================================================

describe('createWorkerHandle', () => {
  let ctx: WorkerMgmtContext;
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    ctx = createMgmtContext();
    workers = new Map();
  });

  it('should create a worker with auto-generated ID', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.id).toMatch(/^worker-[a-f0-9]{8}$/);
    expect(handle.type).toBe('general');
    expect(handle.status).toBe('idle');
    expect(handle.currentTaskIds).toEqual([]);
    expect(handle.createdAt).toBeInstanceOf(Date);
    expect(handle.maxConcurrent).toBe(1);
    expect(handle.defaultTimeout).toBe(300000);
  });

  it('should create a worker with custom ID', () => {
    const handle = createWorkerHandle(ctx, workers, { id: 'custom-id' });

    expect(handle.id).toBe('custom-id');
  });

  it('should create a worker with custom type', () => {
    const handle = createWorkerHandle(ctx, workers, { type: 'skill', skillName: 'my-skill' });

    expect(handle.type).toBe('skill');
    expect(handle.skillName).toBe('my-skill');
  });

  it('should create a worker with custom maxConcurrent', () => {
    const handle = createWorkerHandle(ctx, workers, { maxConcurrent: 4 });

    expect(handle.maxConcurrent).toBe(4);
  });

  it('should create a worker with custom defaultTimeout', () => {
    const handle = createWorkerHandle(ctx, workers, { defaultTimeout: 60000 });

    expect(handle.defaultTimeout).toBe(60000);
  });

  it('should fall back to config defaultTimeout when not specified', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.defaultTimeout).toBe(ctx.config.defaultTimeout);
  });

  it('should register the worker in the workers map', () => {
    const handle = createWorkerHandle(ctx, workers, { id: 'w-1' });

    expect(workers.has('w-1')).toBe(true);
    expect(workers.get('w-1')).toBe(handle);
  });

  it('should emit worker:created event with workerId', () => {
    createWorkerHandle(ctx, workers, { id: 'w-1' });

    expect(ctx.emit).toHaveBeenCalledWith('worker:created', { workerId: 'w-1' });
  });

  it('should initialize stats with zero values', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.stats).toEqual({
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
    });
  });

  it('should create multiple workers with unique IDs', () => {
    const h1 = createWorkerHandle(ctx, workers);
    const h2 = createWorkerHandle(ctx, workers);

    expect(h1.id).not.toBe(h2.id);
    expect(workers.size).toBe(2);
  });
});

// ============================================================================
// Tests: findIdleWorker
// ============================================================================

describe('findIdleWorker', () => {
  it('should return undefined for empty workers map', () => {
    const workers = new Map<string, WorkerHandle>();

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should return the first idle worker', () => {
    const workers = new Map<string, WorkerHandle>();
    const idle = createWorker({ id: 'w-1', status: 'idle' });
    const busy = createWorker({ id: 'w-2', status: 'busy' });
    workers.set('w-1', idle);
    workers.set('w-2', busy);

    const result = findIdleWorker(workers);

    expect(result).toBe(idle);
  });

  it('should return undefined when all workers are busy', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'busy' }));
    workers.set('w-2', createWorker({ id: 'w-2', status: 'busy' }));

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should skip disabled workers', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'disabled' }));

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should skip error workers', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'error' }));

    expect(findIdleWorker(workers)).toBeUndefined();
  });
});

// ============================================================================
// Tests: getIdleWorkers
// ============================================================================

describe('getIdleWorkers', () => {
  it('should return empty array for empty workers map', () => {
    const workers = new Map<string, WorkerHandle>();

    expect(getIdleWorkers(workers)).toEqual([]);
  });

  it('should return only idle workers', () => {
    const workers = new Map<string, WorkerHandle>();
    const idle1 = createWorker({ id: 'w-1', status: 'idle' });
    const busy = createWorker({ id: 'w-2', status: 'busy' });
    const idle2 = createWorker({ id: 'w-3', status: 'idle' });
    workers.set('w-1', idle1);
    workers.set('w-2', busy);
    workers.set('w-3', idle2);

    const result = getIdleWorkers(workers);

    expect(result).toHaveLength(2);
    expect(result).toContain(idle1);
    expect(result).toContain(idle2);
  });

  it('should return empty array when no workers are idle', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'busy' }));
    workers.set('w-2', createWorker({ id: 'w-2', status: 'disabled' }));

    expect(getIdleWorkers(workers)).toEqual([]);
  });
});

// ============================================================================
// Tests: updateWorkerStatus
// ============================================================================

describe('updateWorkerStatus', () => {
  it('should update worker status to busy', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker = createWorker({ id: 'w-1', status: 'idle' });
    workers.set('w-1', worker);
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w-1', 'busy', emit);

    expect(worker.status).toBe('busy');
  });

  it('should update worker status to idle', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker = createWorker({ id: 'w-1', status: 'busy' });
    workers.set('w-1', worker);
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w-1', 'idle', emit);

    expect(worker.status).toBe('idle');
  });

  it('should emit worker:idle event when status becomes idle', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'busy' }));
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w-1', 'idle', emit);

    expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: 'w-1' });
  });

  it('should emit worker:busy event when status becomes busy', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'idle' }));
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w-1', 'busy', emit);

    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w-1' });
  });

  it('should update lastActivityAt timestamp', () => {
    const workers = new Map<string, WorkerHandle>();
    const worker = createWorker({ id: 'w-1', status: 'idle' });
    workers.set('w-1', worker);
    const before = Date.now();

    updateWorkerStatus(workers, 'w-1', 'busy', vi.fn());

    const after = Date.now();
    expect(worker.stats.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(worker.stats.lastActivityAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('should be a no-op for non-existent worker', () => {
    const workers = new Map<string, WorkerHandle>();
    const emit = vi.fn();

    updateWorkerStatus(workers, 'nonexistent', 'busy', emit);

    expect(emit).not.toHaveBeenCalled();
  });

  it('should emit worker:busy for error status (non-idle)', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'idle' }));
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w-1', 'error', emit);

    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w-1' });
  });

  it('should emit worker:busy for disabled status (non-idle)', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'idle' }));
    const emit = vi.fn();

    updateWorkerStatus(workers, 'w-1', 'disabled', emit);

    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w-1' });
  });
});

// ============================================================================
// Tests: ensureMinIdleWorkers
// ============================================================================

describe('ensureMinIdleWorkers', () => {
  let ctx: WorkerMgmtContext;

  beforeEach(() => {
    ctx = createMgmtContext();
  });

  it('should create workers when below minimum', () => {
    const workers = new Map<string, WorkerHandle>();

    ensureMinIdleWorkers(ctx, workers, 2);

    expect(workers.size).toBe(2);
    for (const w of workers.values()) {
      expect(w.status).toBe('idle');
      expect(w.type).toBe('general');
    }
  });

  it('should not create workers when already at minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'idle' }));
    workers.set('w-2', createWorker({ id: 'w-2', status: 'idle' }));

    ensureMinIdleWorkers(ctx, workers, 2);

    // Should still be 2 (no new workers created)
    expect(workers.size).toBe(2);
  });

  it('should not create workers when above minimum', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'idle' }));
    workers.set('w-2', createWorker({ id: 'w-2', status: 'idle' }));
    workers.set('w-3', createWorker({ id: 'w-3', status: 'idle' }));

    ensureMinIdleWorkers(ctx, workers, 2);

    expect(workers.size).toBe(3);
  });

  it('should only count idle workers (not busy ones)', () => {
    const workers = new Map<string, WorkerHandle>();
    workers.set('w-1', createWorker({ id: 'w-1', status: 'busy' }));
    workers.set('w-2', createWorker({ id: 'w-2', status: 'idle' }));

    ensureMinIdleWorkers(ctx, workers, 3);

    // 1 idle + 1 busy = 2 total, need 3 idle, so create 2 more
    expect(workers.size).toBe(4);
  });

  it('should do nothing when minIdle is 0', () => {
    const workers = new Map<string, WorkerHandle>();

    ensureMinIdleWorkers(ctx, workers, 0);

    expect(workers.size).toBe(0);
  });

  it('should emit worker:created for each new worker', () => {
    const workers = new Map<string, WorkerHandle>();

    ensureMinIdleWorkers(ctx, workers, 3);

    expect(ctx.emit).toHaveBeenCalledTimes(3);
    for (const call of (ctx.emit as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe('worker:created');
      expect(call[1]).toHaveProperty('workerId');
    }
  });
});
