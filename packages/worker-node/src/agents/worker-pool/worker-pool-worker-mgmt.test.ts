/**
 * Tests for Worker Pool Worker Management - Worker CRUD operations and status tracking.
 *
 * Tests cover:
 * - Worker handle creation (auto-generated ID, custom options)
 * - Worker queries (idle worker discovery, status filtering)
 * - Worker status updates with event emission
 * - Minimum idle worker maintenance
 *
 * @see worker-pool-worker-mgmt.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerHandle } from './types.js';

// Mock randomUUID for deterministic IDs - use a counter to ensure unique IDs
let uuidCounter = 0;
vi.mock('crypto', () => ({
  randomUUID: () => `${String(++uuidCounter).padStart(8, '0')}-uuid-test`,
}));

import {
  createWorkerHandle,
  findIdleWorker,
  getIdleWorkers,
  updateWorkerStatus,
  ensureMinIdleWorkers,
  type WorkerMgmtContext,
} from './worker-pool-worker-mgmt.js';

function createMockContext(): WorkerMgmtContext {
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

describe('worker-pool-worker-mgmt', () => {
  let ctx: WorkerMgmtContext;
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
    ctx = createMockContext();
    workers = new Map();
  });

  // ============================================================================
  // createWorkerHandle
  // ============================================================================
  describe('createWorkerHandle', () => {
    it('should create a worker with auto-generated ID when no ID provided', () => {
      const handle = createWorkerHandle(ctx, workers);

      expect(handle.id).toBe('worker-00000001');  // worker- + first 8 chars of uuid
      expect(handle.type).toBe('general');
      expect(handle.status).toBe('idle');
      expect(handle.currentTaskIds).toEqual([]);
      expect(handle.maxConcurrent).toBe(1);
      expect(handle.defaultTimeout).toBe(300000);
    });

    it('should create a worker with custom ID', () => {
      const handle = createWorkerHandle(ctx, workers, { id: 'my-worker-1' });

      expect(handle.id).toBe('my-worker-1');
    });

    it('should create a worker with custom type', () => {
      const handle = createWorkerHandle(ctx, workers, { type: 'skill' });

      expect(handle.type).toBe('skill');
    });

    it('should create a worker with skill name', () => {
      const handle = createWorkerHandle(ctx, workers, {
        type: 'skill',
        skillName: 'research',
      });

      expect(handle.skillName).toBe('research');
    });

    it('should create a worker with custom maxConcurrent', () => {
      const handle = createWorkerHandle(ctx, workers, { maxConcurrent: 5 });

      expect(handle.maxConcurrent).toBe(5);
    });

    it('should create a worker with custom timeout', () => {
      const handle = createWorkerHandle(ctx, workers, { defaultTimeout: 60000 });

      expect(handle.defaultTimeout).toBe(60000);
    });

    it('should initialize stats with zeros', () => {
      const handle = createWorkerHandle(ctx, workers);

      expect(handle.stats).toEqual({
        tasksCompleted: 0,
        tasksFailed: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
      });
    });

    it('should set createdAt to a valid date', () => {
      const before = new Date();
      const handle = createWorkerHandle(ctx, workers);
      const after = new Date();

      expect(handle.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(handle.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should register the worker in the workers map', () => {
      const handle = createWorkerHandle(ctx, workers);

      expect(workers.has(handle.id)).toBe(true);
      expect(workers.get(handle.id)).toBe(handle);
    });

    it('should emit worker:created event with workerId', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });

      expect(ctx.emit).toHaveBeenCalledWith('worker:created', { workerId: 'w1' });
    });

    it('should allow creating multiple workers with different IDs', () => {
      const h1 = createWorkerHandle(ctx, workers, { id: 'w1' });
      const h2 = createWorkerHandle(ctx, workers, { id: 'w2' });

      expect(workers.size).toBe(2);
      expect(h1.id).toBe('w1');
      expect(h2.id).toBe('w2');
    });
  });

  // ============================================================================
  // findIdleWorker
  // ============================================================================
  describe('findIdleWorker', () => {
    it('should return undefined when no workers exist', () => {
      expect(findIdleWorker(workers)).toBeUndefined();
    });

    it('should return undefined when all workers are busy', () => {
      const handle = createWorkerHandle(ctx, workers, { id: 'w1' });
      handle.status = 'busy';

      expect(findIdleWorker(workers)).toBeUndefined();
    });

    it('should return the first idle worker', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      createWorkerHandle(ctx, workers, { id: 'w2' });

      const idle = findIdleWorker(workers);
      expect(idle).toBeDefined();
      expect(idle!.status).toBe('idle');
    });

    it('should skip busy workers and find an idle one', () => {
      const busy = createWorkerHandle(ctx, workers, { id: 'w1' });
      busy.status = 'busy';
      createWorkerHandle(ctx, workers, { id: 'w2' }); // idle

      const idle = findIdleWorker(workers);
      expect(idle).toBeDefined();
      expect(idle!.id).toBe('w2');
    });

    it('should skip disabled workers', () => {
      const disabled = createWorkerHandle(ctx, workers, { id: 'w1' });
      disabled.status = 'disabled';
      createWorkerHandle(ctx, workers, { id: 'w2' }); // idle

      const idle = findIdleWorker(workers);
      expect(idle!.id).toBe('w2');
    });

    it('should skip error workers', () => {
      const errorW = createWorkerHandle(ctx, workers, { id: 'w1' });
      errorW.status = 'error';
      createWorkerHandle(ctx, workers, { id: 'w2' }); // idle

      const idle = findIdleWorker(workers);
      expect(idle!.id).toBe('w2');
    });
  });

  // ============================================================================
  // getIdleWorkers
  // ============================================================================
  describe('getIdleWorkers', () => {
    it('should return empty array when no workers exist', () => {
      expect(getIdleWorkers(workers)).toEqual([]);
    });

    it('should return all idle workers', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' }); // idle
      createWorkerHandle(ctx, workers, { id: 'w2' }); // idle

      const idle = getIdleWorkers(workers);
      expect(idle).toHaveLength(2);
    });

    it('should filter out busy workers', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' }); // idle
      const busy = createWorkerHandle(ctx, workers, { id: 'w2' });
      busy.status = 'busy';

      const idle = getIdleWorkers(workers);
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe('w1');
    });

    it('should filter out disabled workers', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' }); // idle
      const disabled = createWorkerHandle(ctx, workers, { id: 'w2' });
      disabled.status = 'disabled';

      const idle = getIdleWorkers(workers);
      expect(idle).toHaveLength(1);
    });

    it('should return empty when all workers are busy or disabled', () => {
      const w1 = createWorkerHandle(ctx, workers, { id: 'w1' });
      w1.status = 'busy';
      const w2 = createWorkerHandle(ctx, workers, { id: 'w2' });
      w2.status = 'disabled';
      const w3 = createWorkerHandle(ctx, workers, { id: 'w3' });
      w3.status = 'error';

      expect(getIdleWorkers(workers)).toEqual([]);
    });
  });

  // ============================================================================
  // updateWorkerStatus
  // ============================================================================
  describe('updateWorkerStatus', () => {
    it('should update worker status to busy', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      const emit = vi.fn();

      updateWorkerStatus(workers, 'w1', 'busy', emit);

      expect(workers.get('w1')!.status).toBe('busy');
    });

    it('should update worker status to idle', () => {
      const handle = createWorkerHandle(ctx, workers, { id: 'w1' });
      handle.status = 'busy';
      const emit = vi.fn();

      updateWorkerStatus(workers, 'w1', 'idle', emit);

      expect(workers.get('w1')!.status).toBe('idle');
    });

    it('should emit worker:idle event when status is idle', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      const emit = vi.fn();

      updateWorkerStatus(workers, 'w1', 'idle', emit);

      expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: 'w1' });
    });

    it('should emit worker:busy event when status is busy', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      const emit = vi.fn();

      updateWorkerStatus(workers, 'w1', 'busy', emit);

      expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
    });

    it('should emit worker:busy event for non-idle statuses like error', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      const emit = vi.fn();

      updateWorkerStatus(workers, 'w1', 'error', emit);

      // error is not 'idle', so it emits 'worker:busy'
      expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: 'w1' });
    });

    it('should update lastActivityAt timestamp', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      const emit = vi.fn();
      const before = new Date();

      updateWorkerStatus(workers, 'w1', 'busy', emit);

      const worker = workers.get('w1')!;
      expect(worker.stats.lastActivityAt).toBeDefined();
      expect(worker.stats.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('should do nothing for non-existent worker', () => {
      const emit = vi.fn();

      updateWorkerStatus(workers, 'nonexistent', 'busy', emit);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // ensureMinIdleWorkers
  // ============================================================================
  describe('ensureMinIdleWorkers', () => {
    it('should create workers to reach minimum idle count', () => {
      ensureMinIdleWorkers(ctx, workers, 3);

      const idleCount = getIdleWorkers(workers).length;
      expect(idleCount).toBe(3);
    });

    it('should not create workers when already at minimum', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      createWorkerHandle(ctx, workers, { id: 'w2' });

      ensureMinIdleWorkers(ctx, workers, 2);

      expect(workers.size).toBe(2);
    });

    it('should not create workers when above minimum', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });
      createWorkerHandle(ctx, workers, { id: 'w2' });
      createWorkerHandle(ctx, workers, { id: 'w3' });

      ensureMinIdleWorkers(ctx, workers, 2);

      expect(workers.size).toBe(3);
    });

    it('should create only the needed number of workers', () => {
      createWorkerHandle(ctx, workers, { id: 'w1' });

      ensureMinIdleWorkers(ctx, workers, 3);

      expect(workers.size).toBe(3); // 1 existing + 2 new
    });

    it('should count only idle workers, not busy ones', () => {
      const busy = createWorkerHandle(ctx, workers, { id: 'w1' });
      busy.status = 'busy';

      ensureMinIdleWorkers(ctx, workers, 2);

      const idleWorkers = getIdleWorkers(workers);
      expect(idleWorkers).toHaveLength(2);
      expect(workers.size).toBe(3); // 1 busy + 2 new idle
    });

    it('should create general type workers', () => {
      ensureMinIdleWorkers(ctx, workers, 1);

      const [worker] = Array.from(workers.values());
      expect(worker.type).toBe('general');
    });

    it('should do nothing when minIdle is 0', () => {
      ensureMinIdleWorkers(ctx, workers, 0);

      expect(workers.size).toBe(0);
    });

    it('should emit worker:created events for new workers', () => {
      ensureMinIdleWorkers(ctx, workers, 2);

      // Each created worker emits a worker:created event
      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls;
      const createdEvents = emitCalls.filter(
        (call: unknown[]) => call[0] === 'worker:created'
      );
      expect(createdEvents).toHaveLength(2);
    });
  });
});
