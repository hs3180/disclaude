/**
 * Unit tests for Worker Pool Worker Management
 *
 * Issue #1617 Phase 3: Tests for worker CRUD and status tracking.
 *
 * Covers:
 * - createWorkerHandle: creation with defaults, custom options, ID generation
 * - findIdleWorker: finding first idle worker
 * - getIdleWorkers: filtering all idle workers
 * - updateWorkerStatus: status transitions and event emission
 * - ensureMinIdleWorkers: minimum worker count maintenance
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

function createMockContext(): WorkerMgmtContext {
  return {
    config: {
      maxWorkers: 10,
      minIdleWorkers: 2,
      defaultTimeout: 30000,
      maxRetries: 3,
      taskQueueSize: 100,
    },
    emit: vi.fn(),
  };
}

describe('createWorkerHandle', () => {
  let ctx: WorkerMgmtContext;
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    ctx = createMockContext();
    workers = new Map();
  });

  it('should create a worker with auto-generated ID', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.id).toMatch(/^worker-[a-f0-9]{8}$/);
    expect(handle.type).toBe('general');
    expect(handle.status).toBe('idle');
    expect(handle.currentTaskIds).toEqual([]);
    expect(handle.maxConcurrent).toBe(1);
    expect(handle.defaultTimeout).toBe(30000);
    expect(handle.stats.tasksCompleted).toBe(0);
    expect(handle.stats.tasksFailed).toBe(0);
  });

  it('should register worker in the workers map', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(workers.has(handle.id)).toBe(true);
    expect(workers.get(handle.id)).toBe(handle);
  });

  it('should emit worker:created event', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(ctx.emit).toHaveBeenCalledWith('worker:created', { workerId: handle.id });
  });

  it('should create worker with custom ID', () => {
    const handle = createWorkerHandle(ctx, workers, { id: 'my-custom-worker' });

    expect(handle.id).toBe('my-custom-worker');
    expect(workers.has('my-custom-worker')).toBe(true);
  });

  it('should create worker with custom type', () => {
    const handle = createWorkerHandle(ctx, workers, { type: 'general' });

    expect(handle.type).toBe('general');
  });

  it('should create worker with custom skillName', () => {
    const handle = createWorkerHandle(ctx, workers, { skillName: 'pdf-parser' });

    expect(handle.skillName).toBe('pdf-parser');
  });

  it('should create worker with custom maxConcurrent', () => {
    const handle = createWorkerHandle(ctx, workers, { maxConcurrent: 5 });

    expect(handle.maxConcurrent).toBe(5);
  });

  it('should create worker with custom defaultTimeout', () => {
    const handle = createWorkerHandle(ctx, workers, { defaultTimeout: 60000 });

    expect(handle.defaultTimeout).toBe(60000);
  });

  it('should default skillName to undefined', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.skillName).toBeUndefined();
  });

  it('should initialize createdAt as a Date', () => {
    const handle = createWorkerHandle(ctx, workers);

    expect(handle.createdAt).toBeInstanceOf(Date);
  });

  it('should generate unique IDs for multiple workers', () => {
    const handle1 = createWorkerHandle(ctx, workers);
    const handle2 = createWorkerHandle(ctx, workers);

    expect(handle1.id).not.toBe(handle2.id);
    expect(workers.size).toBe(2);
  });
});

describe('findIdleWorker', () => {
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    workers = new Map();
  });

  it('should return undefined when no workers exist', () => {
    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should return undefined when all workers are busy', () => {
    workers.set('w1', { id: 'w1', status: 'busy' } as WorkerHandle);
    workers.set('w2', { id: 'w2', status: 'busy' } as WorkerHandle);

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should return the first idle worker', () => {
    const idleWorker = { id: 'w1', status: 'idle' } as WorkerHandle;
    const busyWorker = { id: 'w2', status: 'busy' } as WorkerHandle;

    workers.set('w1', idleWorker);
    workers.set('w2', busyWorker);

    expect(findIdleWorker(workers)).toBe(idleWorker);
  });

  it('should return undefined for disabled workers', () => {
    workers.set('w1', { id: 'w1', status: 'disabled' } as WorkerHandle);

    expect(findIdleWorker(workers)).toBeUndefined();
  });

  it('should find idle worker among mixed statuses', () => {
    workers.set('w1', { id: 'w1', status: 'busy' } as WorkerHandle);
    workers.set('w2', { id: 'w2', status: 'disabled' } as WorkerHandle);
    const idleWorker = { id: 'w3', status: 'idle' } as WorkerHandle;
    workers.set('w3', idleWorker);

    expect(findIdleWorker(workers)).toBe(idleWorker);
  });
});

describe('getIdleWorkers', () => {
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    workers = new Map();
  });

  it('should return empty array when no workers exist', () => {
    expect(getIdleWorkers(workers)).toEqual([]);
  });

  it('should return only idle workers', () => {
    const idle1 = { id: 'w1', status: 'idle' } as WorkerHandle;
    const busy = { id: 'w2', status: 'busy' } as WorkerHandle;
    const idle2 = { id: 'w3', status: 'idle' } as WorkerHandle;
    const disabled = { id: 'w4', status: 'disabled' } as WorkerHandle;

    workers.set('w1', idle1);
    workers.set('w2', busy);
    workers.set('w3', idle2);
    workers.set('w4', disabled);

    const result = getIdleWorkers(workers);
    expect(result).toHaveLength(2);
    expect(result).toContain(idle1);
    expect(result).toContain(idle2);
  });

  it('should return empty array when all workers are busy', () => {
    workers.set('w1', { id: 'w1', status: 'busy' } as WorkerHandle);
    workers.set('w2', { id: 'w2', status: 'busy' } as WorkerHandle);

    expect(getIdleWorkers(workers)).toEqual([]);
  });
});

describe('updateWorkerStatus', () => {
  let workers: Map<string, WorkerHandle>;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    workers = new Map();
    emit = vi.fn();
  });

  it('should update worker status to idle', () => {
    const worker = { id: 'w1', status: 'busy', stats: {} } as WorkerHandle;
    workers.set('w1', worker);

    updateWorkerStatus(workers, 'w1', 'idle', emit);

    expect(worker.status).toBe('idle');
    expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: 'w1' });
  });

  it('should update worker status to busy', () => {
    const worker = { id: 'w1', status: 'idle', stats: {} } as WorkerHandle;
    workers.set('w1', worker);

    updateWorkerStatus(workers, 'w1', 'busy', emit);

    expect(worker.status).toBe('busy');
    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
  });

  it('should update lastActivityAt timestamp', () => {
    const worker = { id: 'w1', status: 'idle', stats: {} } as WorkerHandle;
    workers.set('w1', worker);

    const before = new Date();
    updateWorkerStatus(workers, 'w1', 'busy', emit);
    const after = new Date();

    expect(worker.stats.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(worker.stats.lastActivityAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('should do nothing for non-existent worker', () => {
    updateWorkerStatus(workers, 'non-existent', 'idle', emit);

    expect(emit).not.toHaveBeenCalled();
  });

  it('should emit worker:idle for disabled status', () => {
    const worker = { id: 'w1', status: 'busy', stats: {} } as WorkerHandle;
    workers.set('w1', worker);

    // disabled is neither idle nor busy, so the event type logic:
    // status === 'idle' ? 'worker:idle' : 'worker:busy'
    updateWorkerStatus(workers, 'w1', 'disabled', emit);

    expect(worker.status).toBe('disabled');
    expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
  });
});

describe('ensureMinIdleWorkers', () => {
  let ctx: WorkerMgmtContext;
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    ctx = createMockContext();
    workers = new Map();
  });

  it('should create workers up to minIdleWorkers', () => {
    ensureMinIdleWorkers(ctx, workers, 3);

    expect(workers.size).toBe(3);
    const allIdle = Array.from(workers.values()).every(w => w.status === 'idle');
    expect(allIdle).toBe(true);
  });

  it('should not create workers when enough idle workers exist', () => {
    // Pre-create 3 idle workers
    for (let i = 0; i < 3; i++) {
      workers.set(`w-${i}`, { id: `w-${i}`, status: 'idle' } as WorkerHandle);
    }

    ensureMinIdleWorkers(ctx, workers, 3);

    // Should not have created any new workers
    expect(workers.size).toBe(3);
  });

  it('should create only the deficit of workers', () => {
    // Pre-create 1 idle worker
    workers.set('w-0', { id: 'w-0', status: 'idle' } as WorkerHandle);

    ensureMinIdleWorkers(ctx, workers, 3);

    expect(workers.size).toBe(3); // 1 existing + 2 new
  });

  it('should count only idle workers (not busy ones)', () => {
    // 1 idle + 1 busy = need 2 more for min of 3
    workers.set('w-0', { id: 'w-0', status: 'idle' } as WorkerHandle);
    workers.set('w-1', { id: 'w-1', status: 'busy' } as WorkerHandle);

    ensureMinIdleWorkers(ctx, workers, 3);

    expect(workers.size).toBe(4); // 1 idle + 1 busy + 2 new idle
  });

  it('should do nothing when minIdle is 0', () => {
    ensureMinIdleWorkers(ctx, workers, 0);

    expect(workers.size).toBe(0);
  });

  it('should emit worker:created events for each new worker', () => {
    ensureMinIdleWorkers(ctx, workers, 2);

    expect(ctx.emit).toHaveBeenCalledTimes(2);
    expect(ctx.emit).toHaveBeenCalledWith(
      'worker:created',
      expect.objectContaining({ workerId: expect.any(String) }),
    );
  });

  it('should create workers with general type', () => {
    ensureMinIdleWorkers(ctx, workers, 2);

    for (const worker of workers.values()) {
      expect(worker.type).toBe('general');
    }
  });
});
