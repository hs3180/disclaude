/**
 * Unit tests for TaskContext (Issue #857)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskContext } from './task-context.js';

describe('TaskContext', () => {
  let ctx: TaskContext;

  beforeEach(() => {
    ctx = new TaskContext('test-task-123');
  });

  describe('constructor', () => {
    it('should create a context with pending status', () => {
      expect(ctx.taskId).toBe('test-task-123');
      expect(ctx.isRunning).toBe(false);
      expect(ctx.isFinished).toBe(false);
    });
  });

  describe('start', () => {
    it('should transition to running state', () => {
      ctx.start('Processing data');
      expect(ctx.isRunning).toBe(true);
      expect(ctx.isFinished).toBe(false);
    });
  });

  describe('steps', () => {
    it('should track step lifecycle', () => {
      ctx.start('Test task');
      ctx.addStep('Step A');
      ctx.addStep('Step B');
      ctx.addStep('Step C');

      const progress0 = ctx.getProgress();
      expect(progress0.completedSteps).toBe(0);
      expect(progress0.totalSteps).toBe(3);

      ctx.beginStep(0);
      expect(ctx.getProgress().currentActivity).toBe('Step A');

      ctx.completeStep(0);
      ctx.beginStep(1);
      ctx.completeStep(1);

      const progress = ctx.getProgress();
      expect(progress.completedSteps).toBe(2);
      expect(progress.totalSteps).toBe(3);
    });

    it('should handle failStep', () => {
      ctx.start('Test task');
      ctx.addStep('Step A');
      ctx.beginStep(0);
      ctx.failStep(0, 'Something went wrong');

      const progress = ctx.getProgress();
      expect(progress.errors).toContain('Something went wrong');
    });
  });

  describe('updateActivity', () => {
    it('should update current activity', () => {
      ctx.start('Initial');
      ctx.updateActivity('Parsing files');
      expect(ctx.getProgress().currentActivity).toBe('Parsing files');
    });
  });

  describe('recordToolCall', () => {
    it('should increment tool call count', () => {
      ctx.start('Test');
      ctx.recordToolCall();
      ctx.recordToolCall();
      ctx.recordToolCall();
      expect(ctx.getProgress().toolCallCount).toBe(3);
    });
  });

  describe('recordProgressReport', () => {
    it('should increment progress report count', () => {
      ctx.start('Test');
      ctx.recordProgressReport();
      ctx.recordProgressReport();
      expect(ctx.getProgress().progressReportCount).toBe(2);
    });
  });

  describe('complete', () => {
    it('should transition to completed state', () => {
      ctx.start('Test');
      ctx.complete('All done');
      expect(ctx.isRunning).toBe(false);
      expect(ctx.isFinished).toBe(true);
      expect(ctx.getProgress().status).toBe('completed');
    });

    it('should calculate duration', () => {
      ctx.start('Test');
      ctx.complete('Done');
      expect(ctx.getDurationMs()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('fail', () => {
    it('should transition to failed state with error', () => {
      ctx.start('Test');
      ctx.fail('Timeout');
      expect(ctx.isFinished).toBe(true);
      expect(ctx.getProgress().status).toBe('failed');
      expect(ctx.getProgress().errors).toContain('Timeout');
    });
  });

  describe('getProgress', () => {
    it('should return a complete snapshot', () => {
      ctx.start('Test task');
      ctx.addStep('Step 1');
      ctx.recordToolCall();

      const snapshot = ctx.getProgress();
      expect(snapshot.taskId).toBe('test-task-123');
      expect(snapshot.status).toBe('running');
      expect(snapshot.currentActivity).toBe('Test task');
      expect(snapshot.completedSteps).toBe(0);
      expect(snapshot.totalSteps).toBe(1);
      expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.toolCallCount).toBe(1);
      expect(snapshot.progressReportCount).toBe(0);
    });
  });

  describe('getElapsedTimeString', () => {
    it('should format milliseconds correctly', () => {
      ctx.start('Test');
      const timeStr = ctx.getElapsedTimeString();
      expect(timeStr).toMatch(/\d/);
    });

    it('should return 0ms for unstarted tasks', () => {
      expect(ctx.getElapsedTimeString()).toBe('0ms');
    });
  });
});
