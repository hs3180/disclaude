/**
 * Tests for Worker Pool Worker Management functions.
 *
 * Verifies worker creation, querying, status updates, and minimum idle worker maintenance.
 *
 * Issue #1617: Phase 3 - worker-pool module test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core — needed because worker-pool-health.ts (imported transitively) uses createLogger
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

import {
  createWorkerHandle,
  findIdleWorker,
  getIdleWorkers,
  updateWorkerStatus,
  ensureMinIdleWorkers,
  type WorkerMgmtContext,
} from './worker-pool-worker-mgmt.js';
import type { WorkerHandle, WorkerPoolConfig } from './types.js';

function createMockContext(overrides: Partial<WorkerMgmtContext> = {}): WorkerMgmtContext {
  return {
    config: {
      maxWorkers: 5,
      minIdleWorkers: 1,
      defaultTimeout: 300000,
      maxRetries: 2,
      enablePriority: true,
      maxHistorySize: 100,
      resultRetentionTime: 3600000,
    } satisfies Required<WorkerPoolConfig>,
    emit: vi.fn(),
    ...overrides,
  };
}

describe('worker-pool-worker-mgmt', () => {
  let ctx: WorkerMgmtContext;
  let workers: Map<string, WorkerHandle>;

  beforeEach(() => {
    ctx = createMockContext();
    workers = new Map();
  });

  // ==========================================================================
  // createWorkerHandle
  // ==========================================================================

  describe('createWorkerHandle', () => {
    it('should create a worker with auto-generated ID', () => {
      const handle = createWorkerHandle(ctx, workers);

      expect(handle.id).toBeDefined();
      expect(handle.id).toMatch(/^worker-/);
      expect(handle.type).toBe('general');
      expect(handle.status).toBe('idle');
      expect(handle.currentTaskIds).toEqual([]);
      expect(handle.maxConcurrent).toBe(1);
      expect(handle.defaultTimeout).toBe(300000);
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
      const handle = createWorkerHandle(ctx, workers, { id: 'my-worker-1' });

      expect(handle.id).toBe('my-worker-1');
    });

    it('should create worker with custom type', () => {
      const handle = createWorkerHandle(ctx, workers, { type: 'skill' });

      expect(handle.type).toBe('skill');
    });

    it('should create worker with skill name', () => {
      const handle = createWorkerHandle(ctx, workers, {
        type: 'skill',
        skillName: 'research',
      });

      expect(handle.skillName).toBe('research');
    });

    it('should create worker with custom maxConcurrent', () => {
      const handle = createWorkerHandle(ctx, workers, { maxConcurrent: 5 });

      expect(handle.maxConcurrent).toBe(5);
    });

    it('should create worker with custom timeout', () => {
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

    it('should set createdAt to current date', () => {
      const before = new Date();
      const handle = createWorkerHandle(ctx, workers);
      const after = new Date();

      expect(handle.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(handle.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should create multiple workers with unique IDs', () => {
      const handle1 = createWorkerHandle(ctx, workers);
      const handle2 = createWorkerHandle(ctx, workers);

      expect(handle1.id).not.toBe(handle2.id);
      expect(workers.size).toBe(2);
    });

    it('should return the created handle', () => {
      const handle = createWorkerHandle(ctx, workers);

      expect(handle).toBe(workers.get(handle.id));
    });
  });

  // ==========================================================================
  // findIdleWorker
  // ==========================================================================

  describe('findIdleWorker', () => {
    it('should return undefined when no workers exist', () => {
      expect(findIdleWorker(workers)).toBeUndefined();
    });

    it('should return undefined when all workers are busy', () => {
      const handle = createWorkerHandle(ctx, workers);
      handle.status = 'busy';

      expect(findIdleWorker(workers)).toBeUndefined();
    });

    it('should return the first idle worker', () => {
      const busy = createWorkerHandle(ctx, workers);
      busy.status = 'busy';

      const idle = createWorkerHandle(ctx, workers);

      expect(findIdleWorker(workers)).toBe(idle);
    });

    it('should skip workers in error state', () => {
      const errored = createWorkerHandle(ctx, workers);
      errored.status = 'error';

      expect(findIdleWorker(workers)).toBeUndefined();
    });

    it('should skip disabled workers', () => {
      const disabled = createWorkerHandle(ctx, workers);
      disabled.status = 'disabled';

      expect(findIdleWorker(workers)).toBeUndefined();
    });
  });

  // ==========================================================================
  // getIdleWorkers
  // ==========================================================================

  describe('getIdleWorkers', () => {
    it('should return empty array when no workers exist', () => {
      expect(getIdleWorkers(workers)).toEqual([]);
    });

    it('should return only idle workers', () => {
      const idle1 = createWorkerHandle(ctx, workers);
      const busy = createWorkerHandle(ctx, workers);
      busy.status = 'busy';
      const idle2 = createWorkerHandle(ctx, workers);

      const idle = getIdleWorkers(workers);

      expect(idle).toHaveLength(2);
      expect(idle).toContain(idle1);
      expect(idle).toContain(idle2);
    });

    it('should return empty array when all workers are busy', () => {
      const worker = createWorkerHandle(ctx, workers);
      worker.status = 'busy';

      expect(getIdleWorkers(workers)).toEqual([]);
    });
  });

  // ==========================================================================
  // updateWorkerStatus
  // ==========================================================================

  describe('updateWorkerStatus', () => {
    it('should update worker status', () => {
      const handle = createWorkerHandle(ctx, workers);
      const emit = vi.fn();

      updateWorkerStatus(workers, handle.id, 'busy', emit);

      expect(handle.status).toBe('busy');
    });

    it('should emit worker:busy when status becomes busy', () => {
      const handle = createWorkerHandle(ctx, workers);
      const emit = vi.fn();

      updateWorkerStatus(workers, handle.id, 'busy', emit);

      expect(emit).toHaveBeenCalledWith('worker:busy', { workerId: handle.id });
    });

    it('should emit worker:idle when status becomes idle', () => {
      const handle = createWorkerHandle(ctx, workers);
      handle.status = 'busy';
      const emit = vi.fn();

      updateWorkerStatus(workers, handle.id, 'idle', emit);

      expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: handle.id });
    });

    it('should emit worker:idle when status becomes idle from error', () => {
      const handle = createWorkerHandle(ctx, workers);
      handle.status = 'error';
      const emit = vi.fn();

      updateWorkerStatus(workers, handle.id, 'idle', emit);

      expect(emit).toHaveBeenCalledWith('worker:idle', { workerId: handle.id });
    });

    it('should update lastActivityAt timestamp', () => {
      const handle = createWorkerHandle(ctx, workers);
      const emit = vi.fn();
      const before = new Date();

      updateWorkerStatus(workers, handle.id, 'busy', emit);

      expect(handle.stats.lastActivityAt).toBeDefined();
      expect(handle.stats.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('should do nothing for non-existent worker ID', () => {
      const emit = vi.fn();

      updateWorkerStatus(workers, 'non-existent', 'busy', emit);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // ensureMinIdleWorkers
  // ==========================================================================

  describe('ensureMinIdleWorkers', () => {
    it('should create workers to reach minimum idle count', () => {
      ensureMinIdleWorkers(ctx, workers, 3);

      expect(workers.size).toBe(3);
      for (const worker of workers.values()) {
        expect(worker.status).toBe('idle');
      }
    });

    it('should not create workers when minimum already met', () => {
      createWorkerHandle(ctx, workers);
      createWorkerHandle(ctx, workers);

      ensureMinIdleWorkers(ctx, workers, 2);

      expect(workers.size).toBe(2);
    });

    it('should not create workers when more than minimum idle', () => {
      createWorkerHandle(ctx, workers);
      createWorkerHandle(ctx, workers);
      createWorkerHandle(ctx, workers);

      ensureMinIdleWorkers(ctx, workers, 2);

      expect(workers.size).toBe(3);
    });

    it('should only count idle workers, not busy ones', () => {
      const busy = createWorkerHandle(ctx, workers);
      busy.status = 'busy';

      ensureMinIdleWorkers(ctx, workers, 2);

      // Should have 1 busy + 2 newly created idle = 3 total
      expect(workers.size).toBe(3);
      const idleWorkers = getIdleWorkers(workers);
      expect(idleWorkers).toHaveLength(2);
    });

    it('should do nothing when minIdle is 0', () => {
      ensureMinIdleWorkers(ctx, workers, 0);

      expect(workers.size).toBe(0);
    });

    it('should emit worker:created for each new worker', () => {
      ensureMinIdleWorkers(ctx, workers, 2);

      expect(ctx.emit).toHaveBeenCalledTimes(2);
      for (const call of (ctx.emit as ReturnType<typeof vi.fn>).mock.calls) {
        expect(call[0]).toBe('worker:created');
      }
    });

    it('should create general type workers', () => {
      ensureMinIdleWorkers(ctx, workers, 1);

      const worker = workers.values().next().value!;
      expect(worker.type).toBe('general');
    });
  });
});
