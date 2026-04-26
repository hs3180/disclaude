/**
 * Tests for TaskContext (Issue #857).
 *
 * @module task/task-context.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskContext } from './task-context.js';

describe('TaskContext', () => {
  let tmpDir: string;
  let options: { workspaceDir: string };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
    options = { workspaceDir: tmpDir };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a new TaskContext with initial state', async () => {
      const ctx = await TaskContext.create(options, 'test-task-1', 'oc_chat123', 'Test Task');

      const data = ctx.getData();
      expect(data.taskId).toBe('test-task-1');
      expect(data.chatId).toBe('oc_chat123');
      expect(data.status).toBe('pending');
      expect(data.title).toBe('Test Task');
      expect(data.steps).toEqual([]);
      expect(data.createdAt).toBeDefined();
    });

    it('should persist context to disk', async () => {
      await TaskContext.create(options, 'test-task-1', 'oc_chat123', 'Test Task');

      const contextPath = path.join(tmpDir, 'tasks', 'test-task-1', 'context.md');
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('test-task-1');
      expect(content).toContain('oc_chat123');
      expect(content).toContain('pending');
    });

    it('should sanitize task ID for file system', async () => {
      await TaskContext.create(options, 'task/with/slashes', 'oc_chat', 'Test');

      const contextPath = path.join(tmpDir, 'tasks', 'task_with_slashes', 'context.md');
      const exists = await fs.access(contextPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('load', () => {
    it('should load an existing TaskContext from disk', async () => {
      const original = await TaskContext.create(options, 'test-1', 'oc_chat', 'My Task');
      await original.start();
      await original.addStep('Step 1');
      await original.completeStep(0);

      const loaded = await TaskContext.load(options, 'test-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.getData().taskId).toBe('test-1');
      expect(loaded!.getData().status).toBe('running');
      expect(loaded!.getData().steps).toHaveLength(1);
      expect(loaded!.getData().steps[0].status).toBe('completed');
    });

    it('should return null for non-existent task', async () => {
      const loaded = await TaskContext.load(options, 'non-existent');
      expect(loaded).toBeNull();
    });
  });

  describe('status transitions', () => {
    it('should transition from pending to running', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.start();

      expect(ctx.getData().status).toBe('running');
      expect(ctx.getData().startedAt).toBeDefined();
    });

    it('should transition from running to completed', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.start();
      await ctx.complete();

      expect(ctx.getData().status).toBe('completed');
      expect(ctx.getData().completedAt).toBeDefined();
    });

    it('should transition from running to failed', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.start();
      await ctx.fail('Something went wrong');

      expect(ctx.getData().status).toBe('failed');
      expect(ctx.getData().errorMessage).toBe('Something went wrong');
      expect(ctx.getData().completedAt).toBeDefined();
    });

    it('should mark remaining steps as completed when task completes', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.addStep('Step 1');
      await ctx.addStep('Step 2');
      await ctx.addStep('Step 3');
      await ctx.start();
      await ctx.completeStep(0);
      await ctx.complete();

      const data = ctx.getData();
      expect(data.steps[0].status).toBe('completed');
      expect(data.steps[1].status).toBe('completed');
      expect(data.steps[2].status).toBe('completed');
    });
  });

  describe('step management', () => {
    it('should add steps', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.addStep('Read requirements');
      await ctx.addStep('Implement changes');
      await ctx.addStep('Run tests');

      expect(ctx.getData().steps).toHaveLength(3);
      expect(ctx.getData().steps[0].description).toBe('Read requirements');
      expect(ctx.getData().steps[0].status).toBe('pending');
    });

    it('should start a step', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.addStep('Step 1');
      await ctx.startStep(0);

      expect(ctx.getData().steps[0].status).toBe('running');
      expect(ctx.getData().steps[0].startedAt).toBeDefined();
      expect(ctx.getData().currentOperation).toBe('Step 1');
    });

    it('should complete a step', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.addStep('Step 1');
      await ctx.addStep('Step 2');
      await ctx.startStep(0);
      await ctx.completeStep(0);

      expect(ctx.getData().steps[0].status).toBe('completed');
      expect(ctx.getData().steps[0].completedAt).toBeDefined();
      // currentOperation should move to next pending step
      expect(ctx.getData().currentOperation).toBe('Step 2');
    });

    it('should skip a step', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.addStep('Step 1');
      await ctx.skipStep(0);

      expect(ctx.getData().steps[0].status).toBe('skipped');
    });

    it('should handle invalid step index gracefully', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.addStep('Step 1');
      // These should not throw
      await ctx.startStep(5);
      await ctx.completeStep(-1);
      await ctx.skipStep(100);

      expect(ctx.getData().steps[0].status).toBe('pending');
    });
  });

  describe('currentOperation', () => {
    it('should update current operation', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.updateCurrentOperation('Reading file src/index.ts');

      expect(ctx.getData().currentOperation).toBe('Reading file src/index.ts');
    });
  });

  describe('metadata', () => {
    it('should set and persist metadata', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.setMetadata('prNumber', 123);
      await ctx.setMetadata('branch', 'feat/test');

      expect(ctx.getData().metadata).toEqual({ prNumber: 123, branch: 'feat/test' });
    });
  });

  describe('getSummary', () => {
    it('should return a formatted summary', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Fix auth bug');
      await ctx.addStep('Read code');
      await ctx.addStep('Fix bug');
      await ctx.start();
      await ctx.completeStep(0);

      const summary = ctx.getSummary();
      expect(summary).toContain('Fix auth bug');
      expect(summary).toContain('执行中');
      expect(summary).toContain('1/2 steps completed');
    });

    it('should include error in summary for failed tasks', async () => {
      const ctx = await TaskContext.create(options, 'test-1', 'oc_chat', 'Test');
      await ctx.start();
      await ctx.fail('Build error');

      const summary = ctx.getSummary();
      expect(summary).toContain('Build error');
    });
  });

  describe('persistence roundtrip', () => {
    it('should survive save/load cycle with full data', async () => {
      const ctx = await TaskContext.create(options, 'round-trip', 'oc_chat', 'Full Test');
      await ctx.addStep('Step A');
      await ctx.addStep('Step B');
      await ctx.start();
      await ctx.startStep(0);
      await ctx.completeStep(0);
      await ctx.startStep(1);
      await ctx.setMetadata('key', 'value');

      const loaded = await TaskContext.load(options, 'round-trip');
      expect(loaded).not.toBeNull();

      const data = loaded!.getData();
      expect(data.taskId).toBe('round-trip');
      expect(data.chatId).toBe('oc_chat');
      expect(data.title).toBe('Full Test');
      expect(data.status).toBe('running');
      expect(data.steps).toHaveLength(2);
      expect(data.steps[0].status).toBe('completed');
      expect(data.steps[1].status).toBe('running');
      expect(data.metadata?.key).toBe('value');
    });
  });
});
