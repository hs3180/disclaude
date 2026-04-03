/**
 * Unit tests for TaskContext (Issue #857: progress tracking for Reporter Agent)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskContext, type TaskProgress } from './task-context.js';

describe('TaskContext', () => {
  let tempDir: string;
  let ctx: TaskContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
    ctx = new TaskContext(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initTask', () => {
    it('should create status.json with default values', async () => {
      await ctx.initTask('msg_123', 'Fix auth bug');

      const status = await ctx.getStatus('msg_123');

      expect(status).not.toBeNull();
      expect(status!.taskId).toBe('msg_123');
      expect(status!.title).toBe('Fix auth bug');
      expect(status!.status).toBe('pending');
      expect(status!.currentStep).toBe('Task created, waiting to start...');
      expect(status!.totalSteps).toBe(0);
      expect(status!.completedSteps).toBe(0);
      expect(status!.createdAt).toBeDefined();
      expect(status!.updatedAt).toBeDefined();
    });

    it('should create status.json with custom totalSteps', async () => {
      await ctx.initTask('msg_456', 'Refactor API', { totalSteps: 10 });

      const status = await ctx.getStatus('msg_456');

      expect(status!.totalSteps).toBe(10);
      expect(status!.completedSteps).toBe(0);
    });

    it('should create status.json with metadata', async () => {
      await ctx.initTask('msg_789', 'Add tests', {
        metadata: { chatId: 'oc_test', userId: 'user_1' },
      });

      const status = await ctx.getStatus('msg_789');

      expect(status!.metadata).toEqual({ chatId: 'oc_test', userId: 'user_1' });
    });

    it('should sanitize taskId in file path', async () => {
      await ctx.initTask('msg/with@special#chars', 'Test sanitization');

      const status = await ctx.getStatus('msg/with@special#chars');

      expect(status).not.toBeNull();
      expect(status!.taskId).toBe('msg/with@special#chars');
    });
  });

  describe('startTask', () => {
    it('should set status to running', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');

      const status = await ctx.getStatus('msg_123');

      expect(status!.status).toBe('running');
      expect(status!.startedAt).toBeDefined();
    });

    it('should use custom currentStep', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123', 'Reading source files...');

      const status = await ctx.getStatus('msg_123');

      expect(status!.currentStep).toBe('Reading source files...');
    });
  });

  describe('updateProgress', () => {
    it('should update currentStep', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');
      await ctx.updateProgress('msg_123', { currentStep: 'Writing tests...' });

      const status = await ctx.getStatus('msg_123');

      expect(status!.currentStep).toBe('Writing tests...');
    });

    it('should update completedSteps', async () => {
      await ctx.initTask('msg_123', 'Test task', { totalSteps: 5 });
      await ctx.startTask('msg_123');
      await ctx.updateProgress('msg_123', { completedSteps: 3 });

      const status = await ctx.getStatus('msg_123');

      expect(status!.completedSteps).toBe(3);
    });

    it('should update totalSteps', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.updateProgress('msg_123', { totalSteps: 8 });

      const status = await ctx.getStatus('msg_123');

      expect(status!.totalSteps).toBe(8);
    });

    it('should update updatedAt timestamp', async () => {
      await ctx.initTask('msg_123', 'Test task');
      const statusBefore = await ctx.getStatus('msg_123');
      const updatedAtBefore = statusBefore!.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ctx.updateProgress('msg_123', { currentStep: 'New step' });

      const statusAfter = await ctx.getStatus('msg_123');

      expect(statusAfter!.updatedAt).not.toBe(updatedAtBefore);
    });

    it('should auto-initialize if status.json does not exist', async () => {
      // Don't call initTask, go straight to updateProgress
      await ctx.updateProgress('msg_missing', { currentStep: 'Direct update' });

      const status = await ctx.getStatus('msg_missing');

      expect(status).not.toBeNull();
      expect(status!.title).toBe('Unknown Task');
      expect(status!.currentStep).toBe('Direct update');
    });

    it('should set completedAt when status is completed', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');
      await ctx.updateProgress('msg_123', { status: 'completed' });

      const status = await ctx.getStatus('msg_123');

      expect(status!.completedAt).toBeDefined();
    });

    it('should set completedAt when status is failed', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');
      await ctx.updateProgress('msg_123', { status: 'failed' });

      const status = await ctx.getStatus('msg_123');

      expect(status!.completedAt).toBeDefined();
    });
  });

  describe('completeTask', () => {
    it('should set status to completed', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');
      await ctx.completeTask('msg_123');

      const status = await ctx.getStatus('msg_123');

      expect(status!.status).toBe('completed');
      expect(status!.completedAt).toBeDefined();
    });

    it('should use custom summary', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');
      await ctx.completeTask('msg_123', 'All tests passing');

      const status = await ctx.getStatus('msg_123');

      expect(status!.currentStep).toBe('All tests passing');
    });
  });

  describe('failTask', () => {
    it('should set status to failed with error message', async () => {
      await ctx.initTask('msg_123', 'Test task');
      await ctx.startTask('msg_123');
      await ctx.failTask('msg_123', 'Connection timeout');

      const status = await ctx.getStatus('msg_123');

      expect(status!.status).toBe('failed');
      expect(status!.error).toBe('Connection timeout');
      expect(status!.completedAt).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return null for non-existent task', async () => {
      const status = await ctx.getStatus('non_existent');
      expect(status).toBeNull();
    });

    it('should return task progress for existing task', async () => {
      await ctx.initTask('msg_123', 'Test task');

      const status = await ctx.getStatus('msg_123');

      expect(status).not.toBeNull();
      expect(status!.taskId).toBe('msg_123');
    });
  });

  describe('listAllStatus', () => {
    it('should return empty array when no tasks exist', async () => {
      const all = await ctx.listAllStatus();
      expect(all).toEqual([]);
    });

    it('should return all tasks with status.json', async () => {
      await ctx.initTask('msg_123', 'Task 1');
      await ctx.initTask('msg_456', 'Task 2');
      await ctx.initTask('msg_789', 'Task 3');

      const all = await ctx.listAllStatus();

      expect(all).toHaveLength(3);
      const titles = all.map((t) => t.title).sort();
      expect(titles).toEqual(['Task 1', 'Task 2', 'Task 3']);
    });

    it('should not include task directories without status.json', async () => {
      await ctx.initTask('msg_123', 'With status');

      // Create a task directory without status.json
      const tasksDir = path.join(tempDir, 'tasks', 'msg_no_status');
      await fs.mkdir(tasksDir, { recursive: true });

      const all = await ctx.listAllStatus();

      expect(all).toHaveLength(1);
    });
  });

  describe('getRunningTasks', () => {
    it('should return only running tasks', async () => {
      await ctx.initTask('msg_1', 'Pending task');
      await ctx.initTask('msg_2', 'Running task');
      await ctx.initTask('msg_3', 'Completed task');
      await ctx.startTask('msg_2');
      await ctx.completeTask('msg_3');

      const running = await ctx.getRunningTasks();

      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe('msg_2');
    });

    it('should return empty array when no tasks are running', async () => {
      await ctx.initTask('msg_1', 'Task 1');

      const running = await ctx.getRunningTasks();

      expect(running).toEqual([]);
    });
  });

  describe('getStatusPath', () => {
    it('should return correct path for a task', () => {
      const statusPath = ctx.getStatusPath('msg_123');

      expect(statusPath).toContain('tasks');
      expect(statusPath).toContain('msg_123');
      expect(statusPath).toContain('status.json');
    });

    it('should sanitize special characters in taskId', () => {
      const statusPath = ctx.getStatusPath('msg/with@special#chars');

      // Extract just the directory name (not the full path)
      const dirName = statusPath.split('/').slice(-2, -1)[0];
      expect(dirName).toBe('msg_with_special_chars');
      expect(dirName).not.toContain('@');
      expect(dirName).not.toContain('#');
    });
  });

  describe('formatElapsedTime', () => {
    it('should format seconds', () => {
      const now = new Date().toISOString();
      const progress: TaskProgress = {
        taskId: 'test',
        title: 'Test',
        status: 'running',
        currentStep: 'Step 1',
        totalSteps: 1,
        completedSteps: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: new Date(Date.now() - 45000).toISOString(),
      };

      const elapsed = TaskContext.formatElapsedTime(progress);
      expect(elapsed).toBe('45s');
    });

    it('should format minutes and seconds', () => {
      const now = new Date().toISOString();
      const progress: TaskProgress = {
        taskId: 'test',
        title: 'Test',
        status: 'running',
        currentStep: 'Step 1',
        totalSteps: 1,
        completedSteps: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: new Date(Date.now() - 150000).toISOString(),
      };

      const elapsed = TaskContext.formatElapsedTime(progress);
      expect(elapsed).toBe('2m 30s');
    });

    it('should format hours', () => {
      const now = new Date().toISOString();
      const progress: TaskProgress = {
        taskId: 'test',
        title: 'Test',
        status: 'running',
        currentStep: 'Step 1',
        totalSteps: 1,
        completedSteps: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: new Date(Date.now() - 5400000).toISOString(),
      };

      const elapsed = TaskContext.formatElapsedTime(progress);
      expect(elapsed).toBe('1h 30m');
    });

    it('should use completedAt for completed tasks', () => {
      const createdAt = new Date(Date.now() - 120000).toISOString();
      const completedAt = new Date().toISOString();
      const progress: TaskProgress = {
        taskId: 'test',
        title: 'Test',
        status: 'completed',
        currentStep: 'Done',
        totalSteps: 1,
        completedSteps: 1,
        createdAt,
        updatedAt: completedAt,
        startedAt: createdAt,
        completedAt,
      };

      const elapsed = TaskContext.formatElapsedTime(progress);
      expect(elapsed).toBe('2m 0s');
    });
  });

  describe('formatProgressMarkdown', () => {
    it('should format pending task', () => {
      const progress: TaskProgress = {
        taskId: 'msg_123',
        title: 'Fix auth bug',
        status: 'pending',
        currentStep: 'Waiting to start...',
        totalSteps: 3,
        completedSteps: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const md = TaskContext.formatProgressMarkdown(progress);

      expect(md).toContain('⏳');
      expect(md).toContain('Fix auth bug');
      expect(md).toContain('pending');
      expect(md).toContain('0/3');
    });

    it('should format running task', () => {
      const progress: TaskProgress = {
        taskId: 'msg_123',
        title: 'Refactor API',
        status: 'running',
        currentStep: 'Writing unit tests...',
        totalSteps: 5,
        completedSteps: 2,
        createdAt: new Date(Date.now() - 300000).toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date(Date.now() - 270000).toISOString(),
      };

      const md = TaskContext.formatProgressMarkdown(progress);

      expect(md).toContain('🔄');
      expect(md).toContain('Refactor API');
      expect(md).toContain('running');
      expect(md).toContain('Writing unit tests...');
      expect(md).toContain('2/5');
    });

    it('should format completed task', () => {
      const progress: TaskProgress = {
        taskId: 'msg_123',
        title: 'Add feature',
        status: 'completed',
        currentStep: 'Task completed successfully',
        totalSteps: 3,
        completedSteps: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
      };

      const md = TaskContext.formatProgressMarkdown(progress);

      expect(md).toContain('✅');
      expect(md).toContain('completed');
    });

    it('should format failed task with error', () => {
      const progress: TaskProgress = {
        taskId: 'msg_123',
        title: 'Deploy service',
        status: 'failed',
        currentStep: 'Task failed: timeout',
        totalSteps: 2,
        completedSteps: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date(Date.now() - 120000).toISOString(),
        completedAt: new Date().toISOString(),
        error: 'Connection timeout after 30s',
      };

      const md = TaskContext.formatProgressMarkdown(progress);

      expect(md).toContain('❌');
      expect(md).toContain('failed');
      expect(md).toContain('Connection timeout after 30s');
    });

    it('should skip progress line when totalSteps is 0', () => {
      const progress: TaskProgress = {
        taskId: 'msg_123',
        title: 'Simple task',
        status: 'running',
        currentStep: 'Processing...',
        totalSteps: 0,
        completedSteps: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const md = TaskContext.formatProgressMarkdown(progress);

      expect(md).not.toContain('steps');
      expect(md).toContain('Processing...');
    });
  });
});
