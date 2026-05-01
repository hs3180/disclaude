/**
 * Tests for TaskContext.
 *
 * Verifies shared task state management for the Reporter Agent.
 * Issue #857: Independent Reporter Agent approach.
 * Issue #1617: Phase 2 - task module test coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskContext } from './task-context.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskContext', () => {
  let ctx: TaskContext;

  beforeEach(() => {
    ctx = new TaskContext(tempDir);
  });

  describe('constructor', () => {
    it('should create TaskContext with workspace directory', () => {
      expect(ctx).toBeInstanceOf(TaskContext);
    });
  });

  describe('initContext', () => {
    it('should initialize task context with required fields', async () => {
      const data = await ctx.initContext('task-123', {
        chatId: 'oc_test',
        description: 'Fix bug in auth module',
      });

      expect(data.taskId).toBe('task-123');
      expect(data.status).toBe('pending');
      expect(data.chatId).toBe('oc_test');
      expect(data.description).toBe('Fix bug in auth module');
      expect(data.completedSteps).toEqual([]);
      expect(data.createdAt).toBeDefined();
    });

    it('should initialize with optional fields', async () => {
      const data = await ctx.initContext('task-456', {
        chatId: 'oc_test',
        description: 'Refactor module',
        totalSteps: 5,
        metadata: { source: 'issue-857' },
      });

      expect(data.totalSteps).toBe(5);
      expect(data.metadata).toEqual({ source: 'issue-857' });
    });

    it('should write context.json to task directory', async () => {
      await ctx.initContext('task-789', {
        chatId: 'oc_test',
        description: 'Test task',
      });

      const contextPath = path.join(tempDir, 'tasks', 'task-789', 'context.json');
      const content = await fs.readFile(contextPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.taskId).toBe('task-789');
    });

    it('should sanitize task ID in path', async () => {
      await ctx.initContext('task/special@chars', {
        chatId: 'oc_test',
        description: 'Test',
      });

      const contextPath = path.join(tempDir, 'tasks', 'task_special_chars', 'context.json');
      const content = await fs.readFile(contextPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.taskId).toBe('task/special@chars');
    });
  });

  describe('readContext', () => {
    it('should read existing context', async () => {
      await ctx.initContext('task-read', {
        chatId: 'oc_test',
        description: 'Read test',
      });

      const data = await ctx.readContext('task-read');

      expect(data).not.toBeNull();
      expect(data!.taskId).toBe('task-read');
      expect(data!.description).toBe('Read test');
    });

    it('should return null for non-existent context', async () => {
      const data = await ctx.readContext('nonexistent');

      expect(data).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('should update status to running with startedAt timestamp', async () => {
      await ctx.initContext('task-status', {
        chatId: 'oc_test',
        description: 'Status test',
      });

      await ctx.updateStatus('task-status', 'running');

      const data = await ctx.readContext('task-status');
      expect(data!.status).toBe('running');
      expect(data!.startedAt).toBeDefined();
    });

    it('should update status to completed with completedAt timestamp', async () => {
      await ctx.initContext('task-complete', {
        chatId: 'oc_test',
        description: 'Complete test',
      });

      await ctx.updateStatus('task-complete', 'running');
      await ctx.updateStatus('task-complete', 'completed');

      const data = await ctx.readContext('task-complete');
      expect(data!.status).toBe('completed');
      expect(data!.completedAt).toBeDefined();
    });

    it('should update status to failed with completedAt timestamp', async () => {
      await ctx.initContext('task-fail', {
        chatId: 'oc_test',
        description: 'Fail test',
      });

      await ctx.updateStatus('task-fail', 'failed');

      const data = await ctx.readContext('task-fail');
      expect(data!.status).toBe('failed');
      expect(data!.completedAt).toBeDefined();
    });

    it('should create new context if not found', async () => {
      await ctx.updateStatus('orphan-task', 'pending');

      const data = await ctx.readContext('orphan-task');
      expect(data).not.toBeNull();
      expect(data!.status).toBe('pending');
    });

    it('should merge additional data', async () => {
      await ctx.initContext('task-merge', {
        chatId: 'oc_test',
        description: 'Merge test',
      });

      await ctx.updateStatus('task-merge', 'running', {
        currentIteration: 3,
        totalIterations: 3,
      });

      const data = await ctx.readContext('task-merge');
      expect(data!.currentIteration).toBe(3);
      expect(data!.totalIterations).toBe(3);
    });
  });

  describe('setCurrentStep', () => {
    it('should set current step description', async () => {
      await ctx.initContext('task-step', {
        chatId: 'oc_test',
        description: 'Step test',
      });

      await ctx.setCurrentStep('task-step', 'Reading source files');

      const data = await ctx.readContext('task-step');
      expect(data!.currentStep).toBe('Reading source files');
      expect(data!.status).toBe('running');
    });
  });

  describe('addCompletedStep', () => {
    it('should add step to completed list', async () => {
      await ctx.initContext('task-completed-steps', {
        chatId: 'oc_test',
        description: 'Steps test',
      });

      await ctx.addCompletedStep('task-completed-steps', 'Read files');
      await ctx.addCompletedStep('task-completed-steps', 'Analyze code');

      const data = await ctx.readContext('task-completed-steps');
      expect(data!.completedSteps).toEqual(['Read files', 'Analyze code']);
    });

    it('should clear current step when adding completed step', async () => {
      await ctx.initContext('task-clear-step', {
        chatId: 'oc_test',
        description: 'Clear step test',
      });

      await ctx.setCurrentStep('task-clear-step', 'Working on it');
      await ctx.addCompletedStep('task-clear-step', 'Working on it');

      const data = await ctx.readContext('task-clear-step');
      expect(data!.currentStep).toBeUndefined();
      expect(data!.completedSteps).toContain('Working on it');
    });

    it('should handle missing context gracefully', async () => {
      // Should not throw
      await ctx.addCompletedStep('nonexistent-task', 'Some step');
    });
  });

  describe('setIteration', () => {
    it('should set current iteration', async () => {
      await ctx.initContext('task-iter', {
        chatId: 'oc_test',
        description: 'Iteration test',
      });

      await ctx.setIteration('task-iter', 2);

      const data = await ctx.readContext('task-iter');
      expect(data!.currentIteration).toBe(2);
      expect(data!.totalIterations).toBe(2);
    });
  });

  describe('recordError', () => {
    it('should record error and set failed status', async () => {
      await ctx.initContext('task-error', {
        chatId: 'oc_test',
        description: 'Error test',
      });

      await ctx.recordError('task-error', 'Build failed with exit code 1');

      const data = await ctx.readContext('task-error');
      expect(data!.status).toBe('failed');
      expect(data!.error).toBe('Build failed with exit code 1');
    });
  });

  describe('hasContext', () => {
    it('should return true for existing context', async () => {
      await ctx.initContext('task-exists', {
        chatId: 'oc_test',
        description: 'Exists test',
      });

      expect(await ctx.hasContext('task-exists')).toBe(true);
    });

    it('should return false for non-existent context', async () => {
      expect(await ctx.hasContext('nonexistent')).toBe(false);
    });
  });

  describe('listActiveTasks', () => {
    it('should list pending and running tasks', async () => {
      await ctx.initContext('task-active-1', {
        chatId: 'oc_test',
        description: 'Active task 1',
      });
      await ctx.initContext('task-active-2', {
        chatId: 'oc_test',
        description: 'Active task 2',
      });
      await ctx.initContext('task-done', {
        chatId: 'oc_test',
        description: 'Done task',
      });
      await ctx.updateStatus('task-done', 'completed');

      const activeTasks = await ctx.listActiveTasks();

      expect(activeTasks).toContain('task-active-1');
      expect(activeTasks).toContain('task-active-2');
      expect(activeTasks).not.toContain('task-done');
    });

    it('should return empty array when no tasks', async () => {
      const activeTasks = await ctx.listActiveTasks();
      expect(activeTasks).toEqual([]);
    });
  });

  describe('getSummary', () => {
    it('should generate human-readable summary for running task', async () => {
      await ctx.initContext('task-summary', {
        chatId: 'oc_test',
        description: 'Summary test',
        totalSteps: 3,
      });
      await ctx.updateStatus('task-summary', 'running');
      await ctx.addCompletedStep('task-summary', 'Step 1');
      await ctx.setCurrentStep('task-summary', 'Step 2');

      const summary = await ctx.getSummary('task-summary');

      expect(summary).not.toBeNull();
      expect(summary!).toContain('🔄');
      expect(summary!).toContain('Summary test');
      expect(summary!).toContain('running');
      expect(summary!).toContain('Step 2');
      expect(summary!).toContain('1/3');
    });

    it('should generate summary for completed task', async () => {
      await ctx.initContext('task-done-summary', {
        chatId: 'oc_test',
        description: 'Done summary test',
      });
      await ctx.updateStatus('task-done-summary', 'completed');

      const summary = await ctx.getSummary('task-done-summary');

      expect(summary).not.toBeNull();
      expect(summary!).toContain('✅');
    });

    it('should generate summary for failed task', async () => {
      await ctx.initContext('task-fail-summary', {
        chatId: 'oc_test',
        description: 'Fail summary test',
      });
      await ctx.recordError('task-fail-summary', 'Something went wrong');

      const summary = await ctx.getSummary('task-fail-summary');

      expect(summary).not.toBeNull();
      expect(summary!).toContain('❌');
      expect(summary!).toContain('Something went wrong');
    });

    it('should return null for non-existent task', async () => {
      const summary = await ctx.getSummary('nonexistent');
      expect(summary).toBeNull();
    });
  });

  describe('full lifecycle', () => {
    it('should handle complete task lifecycle', async () => {
      // Initialize
      const data = await ctx.initContext('task-lifecycle', {
        chatId: 'oc_lifecycle',
        description: 'Full lifecycle test',
        totalSteps: 3,
      });
      expect(data.status).toBe('pending');

      // Start
      await ctx.updateStatus('task-lifecycle', 'running');
      let current = await ctx.readContext('task-lifecycle');
      expect(current!.status).toBe('running');
      expect(current!.startedAt).toBeDefined();

      // Step 1
      await ctx.setCurrentStep('task-lifecycle', 'Reading files');
      current = await ctx.readContext('task-lifecycle');
      expect(current!.currentStep).toBe('Reading files');

      await ctx.addCompletedStep('task-lifecycle', 'Reading files');
      current = await ctx.readContext('task-lifecycle');
      expect(current!.completedSteps).toEqual(['Reading files']);
      expect(current!.currentStep).toBeUndefined();

      // Step 2
      await ctx.setIteration('task-lifecycle', 1);
      await ctx.setCurrentStep('task-lifecycle', 'Implementing fix');
      await ctx.addCompletedStep('task-lifecycle', 'Implementing fix');

      // Step 3
      await ctx.setIteration('task-lifecycle', 2);
      await ctx.setCurrentStep('task-lifecycle', 'Running tests');
      await ctx.addCompletedStep('task-lifecycle', 'Running tests');

      // Complete
      await ctx.updateStatus('task-lifecycle', 'completed');
      current = await ctx.readContext('task-lifecycle');
      expect(current!.status).toBe('completed');
      expect(current!.completedAt).toBeDefined();
      expect(current!.completedSteps).toHaveLength(3);
      expect(current!.currentIteration).toBe(2);

      // Verify summary
      const summary = await ctx.getSummary('task-lifecycle');
      expect(summary).toContain('✅');
      expect(summary).toContain('3/3');
    });
  });
});
