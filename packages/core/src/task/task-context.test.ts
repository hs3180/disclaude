/**
 * Tests for TaskContext.
 *
 * Verifies in-memory task state tracking for the Reporter Agent pattern (Issue #857).
 *
 * Issue #1617: Phase 2 - task module test coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskContext, getTaskContext, resetTaskContext } from './task-context.js';

describe('TaskContext', () => {
  let ctx: TaskContext;

  beforeEach(() => {
    resetTaskContext();
    ctx = new TaskContext();
  });

  afterEach(() => {
    resetTaskContext();
  });

  describe('create', () => {
    it('should create a task context entry', () => {
      const entry = ctx.create('task-1', 'oc_chat', 'Build a REST API');

      expect(entry.taskId).toBe('task-1');
      expect(entry.chatId).toBe('oc_chat');
      expect(entry.description).toBe('Build a REST API');
      expect(entry.status).toBe('pending');
      expect(entry.completedSteps).toEqual([]);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();
    });

    it('should fire update callback on create', () => {
      const callback = vi.fn();
      ctx.onUpdate(callback);

      ctx.create('task-1', 'oc_chat', 'Test');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', status: 'pending' })
      );
    });
  });

  describe('updateStatus', () => {
    it('should update task status', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      const updated = ctx.updateStatus('task-1', 'running');

      expect(updated).toBeDefined();
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeTruthy();
    });

    it('should set startedAt when status becomes running', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      const entry = ctx.updateStatus('task-1', 'running');

      expect(entry!.startedAt).toBeTruthy();
    });

    it('should set finishedAt when status becomes completed', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.updateStatus('task-1', 'running');
      const entry = ctx.updateStatus('task-1', 'completed');

      expect(entry!.finishedAt).toBeTruthy();
    });

    it('should set finishedAt when status becomes failed', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.updateStatus('task-1', 'running');
      const entry = ctx.updateStatus('task-1', 'failed', { error: 'Something went wrong' });

      expect(entry!.finishedAt).toBeTruthy();
      expect(entry!.error).toBe('Something went wrong');
    });

    it('should update extra fields', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      const entry = ctx.updateStatus('task-1', 'running', {
        currentStep: 'Writing code',
        currentIteration: 2,
        totalIterations: 5,
        totalSteps: 10,
      });

      expect(entry!.currentStep).toBe('Writing code');
      expect(entry!.currentIteration).toBe(2);
      expect(entry!.totalIterations).toBe(5);
      expect(entry!.totalSteps).toBe(10);
    });

    it('should return undefined for unknown task', () => {
      const result = ctx.updateStatus('unknown', 'running');
      expect(result).toBeUndefined();
    });

    it('should fire update callback on status change', () => {
      const callback = vi.fn();
      ctx.onUpdate(callback);
      ctx.create('task-1', 'oc_chat', 'Test');

      ctx.updateStatus('task-1', 'running');

      // 1 for create + 1 for updateStatus
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'running' })
      );
    });
  });

  describe('completeStep', () => {
    it('should record a completed step', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      const entry = ctx.completeStep('task-1', 'Read existing code');

      expect(entry!.completedSteps).toEqual(['Read existing code']);
    });

    it('should accumulate multiple steps', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.completeStep('task-1', 'Step 1');
      ctx.completeStep('task-1', 'Step 2');
      ctx.completeStep('task-1', 'Step 3');

      const entry = ctx.get('task-1');
      expect(entry!.completedSteps).toEqual(['Step 1', 'Step 2', 'Step 3']);
    });

    it('should return undefined for unknown task', () => {
      const result = ctx.completeStep('unknown', 'Step');
      expect(result).toBeUndefined();
    });
  });

  describe('get', () => {
    it('should return entry by taskId', () => {
      const created = ctx.create('task-1', 'oc_chat', 'Test');
      const retrieved = ctx.get('task-1');

      expect(retrieved).toBe(created);
    });

    it('should return undefined for unknown taskId', () => {
      expect(ctx.get('unknown')).toBeUndefined();
    });
  });

  describe('getActiveTaskForChat', () => {
    it('should return active task for a chat', () => {
      ctx.create('task-1', 'oc_chat1', 'Test 1');
      ctx.create('task-2', 'oc_chat2', 'Test 2');

      const active = ctx.getActiveTaskForChat('oc_chat1');
      expect(active).toBeDefined();
      expect(active!.taskId).toBe('task-1');
    });

    it('should return undefined if no active task for chat', () => {
      ctx.create('task-1', 'oc_chat1', 'Test');
      ctx.updateStatus('task-1', 'completed');

      expect(ctx.getActiveTaskForChat('oc_chat1')).toBeUndefined();
    });

    it('should skip completed tasks', () => {
      ctx.create('task-1', 'oc_chat1', 'Test');
      ctx.updateStatus('task-1', 'completed');

      expect(ctx.getActiveTaskForChat('oc_chat1')).toBeUndefined();
    });

    it('should skip failed tasks', () => {
      ctx.create('task-1', 'oc_chat1', 'Test');
      ctx.updateStatus('task-1', 'failed');

      expect(ctx.getActiveTaskForChat('oc_chat1')).toBeUndefined();
    });
  });

  describe('listActive', () => {
    it('should list only active tasks', () => {
      ctx.create('task-1', 'oc_chat1', 'Active 1');
      ctx.create('task-2', 'oc_chat2', 'Active 2');
      ctx.create('task-3', 'oc_chat3', 'Completed');
      ctx.updateStatus('task-3', 'completed');

      const active = ctx.listActive();
      expect(active).toHaveLength(2);
      expect(active.map(e => e.taskId)).toEqual(expect.arrayContaining(['task-1', 'task-2']));
    });

    it('should return empty array when no active tasks', () => {
      expect(ctx.listActive()).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('should list all tasks including completed', () => {
      ctx.create('task-1', 'oc_chat1', 'Active');
      ctx.create('task-2', 'oc_chat2', 'Completed');
      ctx.updateStatus('task-2', 'completed');

      const all = ctx.listAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should delete a task entry', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      expect(ctx.delete('task-1')).toBe(true);
      expect(ctx.get('task-1')).toBeUndefined();
    });

    it('should return false for unknown task', () => {
      expect(ctx.delete('unknown')).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up old completed tasks', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.updateStatus('task-1', 'completed');

      // Manually set finishedAt to 2 hours ago
      const entry = ctx.get('task-1')!;
      entry.finishedAt = new Date(Date.now() - 7200000).toISOString();

      const cleaned = ctx.cleanup(3600000); // 1 hour max age
      expect(cleaned).toBe(1);
      expect(ctx.get('task-1')).toBeUndefined();
    });

    it('should not clean up recent completed tasks', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.updateStatus('task-1', 'completed');

      const cleaned = ctx.cleanup(3600000);
      expect(cleaned).toBe(0);
      expect(ctx.get('task-1')).toBeDefined();
    });

    it('should not clean up active tasks', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.updateStatus('task-1', 'running');

      // Even with old updatedAt
      const entry = ctx.get('task-1')!;
      entry.updatedAt = new Date(Date.now() - 7200000).toISOString();

      const cleaned = ctx.cleanup(3600000);
      expect(cleaned).toBe(0);
    });

    it('should clean up old failed tasks', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      ctx.updateStatus('task-1', 'failed', { error: 'Error' });

      const entry = ctx.get('task-1')!;
      entry.finishedAt = new Date(Date.now() - 7200000).toISOString();

      const cleaned = ctx.cleanup(3600000);
      expect(cleaned).toBe(1);
    });
  });

  describe('size and has', () => {
    it('should return correct size', () => {
      expect(ctx.size).toBe(0);
      ctx.create('task-1', 'oc_chat', 'Test');
      expect(ctx.size).toBe(1);
      ctx.create('task-2', 'oc_chat', 'Test 2');
      expect(ctx.size).toBe(2);
    });

    it('should check if task exists', () => {
      ctx.create('task-1', 'oc_chat', 'Test');
      expect(ctx.has('task-1')).toBe(true);
      expect(ctx.has('unknown')).toBe(false);
    });
  });

  describe('onUpdate callback', () => {
    it('should support unsubscribing', () => {
      const callback = vi.fn();
      const unsub = ctx.onUpdate(callback);

      ctx.create('task-1', 'oc_chat', 'Test');
      expect(callback).toHaveBeenCalledTimes(1);

      unsub();

      ctx.updateStatus('task-1', 'running');
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should handle callback errors gracefully', () => {
      const badCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const goodCallback = vi.fn();

      ctx.onUpdate(badCallback);
      ctx.onUpdate(goodCallback);

      ctx.create('task-1', 'oc_chat', 'Test');

      expect(badCallback).toHaveBeenCalledTimes(1);
      expect(goodCallback).toHaveBeenCalledTimes(1); // Still called after bad callback
    });
  });
});

describe('getTaskContext singleton', () => {
  afterEach(() => {
    resetTaskContext();
  });

  it('should return the same instance', () => {
    const ctx1 = getTaskContext();
    const ctx2 = getTaskContext();
    expect(ctx1).toBe(ctx2);
  });

  it('should return new instance after reset', () => {
    const ctx1 = getTaskContext();
    resetTaskContext();
    const ctx2 = getTaskContext();
    expect(ctx1).not.toBe(ctx2);
  });
});
