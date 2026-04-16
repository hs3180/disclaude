/**
 * Tests for TaskContext.
 *
 * Verifies task context lifecycle, step management, and progress reporting.
 *
 * Issue #857: Task Context data structure for progress reporting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskContext } from './task-context.js';

let tempDir: string;
let ctx: TaskContext;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
  ctx = new TaskContext({ workspaceDir: tempDir });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskContext', () => {
  describe('constructor', () => {
    it('should create TaskContext instance', () => {
      expect(ctx).toBeInstanceOf(TaskContext);
    });
  });

  describe('getContextPath', () => {
    it('should return path with context.json', () => {
      const result = ctx.getContextPath('msg-123');
      expect(result).toContain('tasks');
      expect(result).toContain('msg-123');
      expect(result).toContain('context.json');
    });

    it('should sanitize task ID', () => {
      const result = ctx.getContextPath('msg/123@abc');
      const dirName = path.basename(path.dirname(result));
      expect(dirName).not.toContain('/');
      expect(dirName).not.toContain('@');
    });
  });

  describe('create', () => {
    it('should create a new task context in pending state', async () => {
      const data = await ctx.create('msg-1', {
        description: 'Fix the auth bug',
        chatId: 'oc_test',
        steps: ['Analyze code', 'Fix bug', 'Run tests'],
      });

      expect(data.taskId).toBe('msg-1');
      expect(data.description).toBe('Fix the auth bug');
      expect(data.status).toBe('pending');
      expect(data.chatId).toBe('oc_test');
      expect(data.steps).toHaveLength(3);
      expect(data.steps[0].name).toBe('Analyze code');
      expect(data.steps[0].status).toBe('pending');
      expect(data.createdAt).toBeTruthy();
      expect(data.iterationsCompleted).toBe(0);
      expect(data.filesModified).toEqual([]);
    });

    it('should persist context to disk', async () => {
      await ctx.create('msg-2', {
        description: 'Test task',
        chatId: 'oc_test',
      });

      const contextPath = ctx.getContextPath('msg-2');
      const raw = await fs.readFile(contextPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.taskId).toBe('msg-2');
      expect(parsed.status).toBe('pending');
    });

    it('should work without steps', async () => {
      const data = await ctx.create('msg-3', {
        description: 'No steps task',
        chatId: 'oc_test',
      });

      expect(data.steps).toHaveLength(0);
    });
  });

  describe('read', () => {
    it('should read existing context', async () => {
      await ctx.create('msg-r-1', {
        description: 'Read test',
        chatId: 'oc_test',
      });

      const data = await ctx.read('msg-r-1');
      expect(data).not.toBeNull();
      expect(data!.taskId).toBe('msg-r-1');
    });

    it('should return null for non-existent context', async () => {
      const data = await ctx.read('nonexistent');
      expect(data).toBeNull();
    });
  });

  describe('exists', () => {
    it('should return true for existing context', async () => {
      await ctx.create('msg-e-1', {
        description: 'Exists test',
        chatId: 'oc_test',
      });

      expect(await ctx.exists('msg-e-1')).toBe(true);
    });

    it('should return false for non-existent context', async () => {
      expect(await ctx.exists('nonexistent')).toBe(false);
    });
  });

  describe('start', () => {
    it('should transition to running state', async () => {
      await ctx.create('msg-s-1', {
        description: 'Start test',
        chatId: 'oc_test',
        steps: ['Step 1', 'Step 2'],
      });

      const data = await ctx.start('msg-s-1');
      expect(data).not.toBeNull();
      expect(data!.status).toBe('running');
      expect(data!.startedAt).toBeTruthy();
      // First pending step should become running
      expect(data!.steps[0].status).toBe('running');
      expect(data!.steps[0].startedAt).toBeTruthy();
      // Second step should still be pending
      expect(data!.steps[1].status).toBe('pending');
    });

    it('should return null for non-existent task', async () => {
      const data = await ctx.start('nonexistent');
      expect(data).toBeNull();
    });
  });

  describe('complete', () => {
    it('should transition to completed state', async () => {
      await ctx.create('msg-c-1', {
        description: 'Complete test',
        chatId: 'oc_test',
        steps: ['Step 1'],
      });
      await ctx.start('msg-c-1');

      const data = await ctx.complete('msg-c-1');
      expect(data!.status).toBe('completed');
      expect(data!.completedAt).toBeTruthy();
      // Running step should become completed
      expect(data!.steps[0].status).toBe('completed');
    });

    it('should return null for non-existent task', async () => {
      const data = await ctx.complete('nonexistent');
      expect(data).toBeNull();
    });
  });

  describe('fail', () => {
    it('should transition to failed state with error', async () => {
      await ctx.create('msg-f-1', {
        description: 'Fail test',
        chatId: 'oc_test',
        steps: ['Step 1'],
      });
      await ctx.start('msg-f-1');

      const data = await ctx.fail('msg-f-1', 'Something went wrong');
      expect(data!.status).toBe('failed');
      expect(data!.error).toBe('Something went wrong');
      expect(data!.completedAt).toBeTruthy();
      // Running step should become failed
      expect(data!.steps[0].status).toBe('failed');
      expect(data!.steps[0].error).toBe('Something went wrong');
    });

    it('should return null for non-existent task', async () => {
      const data = await ctx.fail('nonexistent', 'error');
      expect(data).toBeNull();
    });
  });

  describe('updateStep', () => {
    it('should update a specific step status', async () => {
      await ctx.create('msg-us-1', {
        description: 'Update step test',
        chatId: 'oc_test',
        steps: ['Step A', 'Step B'],
      });

      const data = await ctx.updateStep('msg-us-1', 0, { status: 'running' });
      expect(data!.steps[0].status).toBe('running');
      expect(data!.steps[0].startedAt).toBeTruthy();
      expect(data!.steps[1].status).toBe('pending');
    });

    it('should complete a step', async () => {
      await ctx.create('msg-us-2', {
        description: 'Complete step test',
        chatId: 'oc_test',
        steps: ['Step A'],
      });
      await ctx.updateStep('msg-us-2', 0, { status: 'running' });

      const data = await ctx.updateStep('msg-us-2', 0, { status: 'completed' });
      expect(data!.steps[0].status).toBe('completed');
      expect(data!.steps[0].completedAt).toBeTruthy();
    });

    it('should handle out of range step index gracefully', async () => {
      await ctx.create('msg-us-3', {
        description: 'Out of range test',
        chatId: 'oc_test',
        steps: ['Step A'],
      });

      const data = await ctx.updateStep('msg-us-3', 99, { status: 'completed' });
      // Should return data unchanged
      expect(data).not.toBeNull();
      expect(data!.steps[0].status).toBe('pending');
    });

    it('should return null for non-existent task', async () => {
      const data = await ctx.updateStep('nonexistent', 0, { status: 'running' });
      expect(data).toBeNull();
    });
  });

  describe('addStep', () => {
    it('should add a new step', async () => {
      await ctx.create('msg-as-1', {
        description: 'Add step test',
        chatId: 'oc_test',
        steps: ['Initial step'],
      });

      const data = await ctx.addStep('msg-as-1', 'Additional step');
      expect(data!.steps).toHaveLength(2);
      expect(data!.steps[1].name).toBe('Additional step');
      expect(data!.steps[1].status).toBe('pending');
    });

    it('should return null for non-existent task', async () => {
      const data = await ctx.addStep('nonexistent', 'New step');
      expect(data).toBeNull();
    });
  });

  describe('setCurrentActivity', () => {
    it('should update current activity', async () => {
      await ctx.create('msg-ca-1', {
        description: 'Activity test',
        chatId: 'oc_test',
      });

      const data = await ctx.setCurrentActivity('msg-ca-1', 'Modifying auth.service.ts');
      expect(data!.currentActivity).toBe('Modifying auth.service.ts');
    });

    it('should return null for non-existent task', async () => {
      const data = await ctx.setCurrentActivity('nonexistent', 'activity');
      expect(data).toBeNull();
    });
  });

  describe('incrementIterations', () => {
    it('should increment iteration counter', async () => {
      await ctx.create('msg-ii-1', {
        description: 'Iteration test',
        chatId: 'oc_test',
      });

      await ctx.incrementIterations('msg-ii-1');
      await ctx.incrementIterations('msg-ii-1');
      const data = await ctx.read('msg-ii-1');
      expect(data!.iterationsCompleted).toBe(2);
    });
  });

  describe('addModifiedFile', () => {
    it('should add a file to modified list', async () => {
      await ctx.create('msg-amf-1', {
        description: 'File test',
        chatId: 'oc_test',
      });

      const data = await ctx.addModifiedFile('msg-amf-1', 'src/auth.ts');
      expect(data!.filesModified).toContain('src/auth.ts');
    });

    it('should not add duplicate files', async () => {
      await ctx.create('msg-amf-2', {
        description: 'Dedup test',
        chatId: 'oc_test',
      });

      await ctx.addModifiedFile('msg-amf-2', 'src/auth.ts');
      await ctx.addModifiedFile('msg-amf-2', 'src/auth.ts');
      const data = await ctx.read('msg-amf-2');
      expect(data!.filesModified).toHaveLength(1);
    });
  });

  describe('getElapsedTime', () => {
    it('should return null before task starts', async () => {
      await ctx.create('msg-et-1', {
        description: 'Elapsed test',
        chatId: 'oc_test',
      });

      const elapsed = await ctx.getElapsedTime('msg-et-1');
      expect(elapsed).toBeNull();
    });

    it('should return elapsed time after task starts', async () => {
      await ctx.create('msg-et-2', {
        description: 'Elapsed test',
        chatId: 'oc_test',
      });
      await ctx.start('msg-et-2');

      const elapsed = await ctx.getElapsedTime('msg-et-2');
      expect(elapsed).not.toBeNull();
      expect(elapsed!).toBeGreaterThanOrEqual(0);
    });

    it('should return null for non-existent task', async () => {
      const elapsed = await ctx.getElapsedTime('nonexistent');
      expect(elapsed).toBeNull();
    });
  });

  describe('getProgressSummary', () => {
    it('should return progress summary', async () => {
      await ctx.create('msg-ps-1', {
        description: 'Summary test',
        chatId: 'oc_test',
        steps: ['Step 1', 'Step 2', 'Step 3'],
      });
      await ctx.start('msg-ps-1');
      await ctx.updateStep('msg-ps-1', 0, { status: 'completed' });

      const summary = await ctx.getProgressSummary('msg-ps-1');
      expect(summary).not.toBeNull();
      expect(summary!.status).toBe('running');
      expect(summary!.completedSteps).toBe(1);
      expect(summary!.totalSteps).toBe(3);
      expect(summary!.elapsedMs).not.toBeNull();
      expect(summary!.iterationsCompleted).toBe(0);
    });

    it('should return null for non-existent task', async () => {
      const summary = await ctx.getProgressSummary('nonexistent');
      expect(summary).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('should remove context file', async () => {
      await ctx.create('msg-cl-1', {
        description: 'Cleanup test',
        chatId: 'oc_test',
      });

      expect(await ctx.exists('msg-cl-1')).toBe(true);
      await ctx.cleanup('msg-cl-1');
      expect(await ctx.exists('msg-cl-1')).toBe(false);
    });

    it('should not throw for non-existent file', async () => {
      await expect(ctx.cleanup('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('full lifecycle', () => {
    it('should handle complete task lifecycle', async () => {
      // Create
      const created = await ctx.create('msg-life-1', {
        description: 'Lifecycle test',
        chatId: 'oc_test',
        steps: ['Analyze', 'Implement', 'Test'],
      });
      expect(created.status).toBe('pending');

      // Start
      const started = await ctx.start('msg-life-1');
      expect(started!.status).toBe('running');
      expect(started!.steps[0].status).toBe('running');

      // Update step progress
      await ctx.setCurrentActivity('msg-life-1', 'Analyzing code...');
      await ctx.updateStep('msg-life-1', 0, { status: 'completed' });

      // Move to next step
      await ctx.updateStep('msg-life-1', 1, { status: 'running' });
      await ctx.setCurrentActivity('msg-life-1', 'Implementing fix...');
      await ctx.addModifiedFile('msg-life-1', 'src/auth.ts');
      await ctx.updateStep('msg-life-1', 1, { status: 'completed' });

      // Move to last step
      await ctx.updateStep('msg-life-1', 2, { status: 'running' });
      await ctx.setCurrentActivity('msg-life-1', 'Running tests...');
      await ctx.incrementIterations('msg-life-1');
      await ctx.updateStep('msg-life-1', 2, { status: 'completed' });

      // Complete
      const completed = await ctx.complete('msg-life-1');
      expect(completed!.status).toBe('completed');
      expect(completed!.steps.every(s => s.status === 'completed')).toBe(true);
      expect(completed!.iterationsCompleted).toBe(1);
      expect(completed!.filesModified).toContain('src/auth.ts');

      // Verify progress summary
      const summary = await ctx.getProgressSummary('msg-life-1');
      expect(summary!.completedSteps).toBe(3);
      expect(summary!.totalSteps).toBe(3);
      expect(summary!.status).toBe('completed');
    });

    it('should handle failed task lifecycle', async () => {
      await ctx.create('msg-life-2', {
        description: 'Fail lifecycle test',
        chatId: 'oc_test',
        steps: ['Step 1'],
      });
      await ctx.start('msg-life-2');
      const failed = await ctx.fail('msg-life-2', 'Build error');

      expect(failed!.status).toBe('failed');
      expect(failed!.error).toBe('Build error');
      expect(failed!.steps[0].status).toBe('failed');
      expect(failed!.steps[0].error).toBe('Build error');
    });
  });
});
