/**
 * Unit tests for TaskContext module.
 *
 * Tests file-based task context for inter-agent communication (Issue #857).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TaskContext,
  formatDuration,
} from './task-context.js';
import { getTaskStatus, updateTaskStatus, createTaskContext } from './task-context-tools.js';

describe('task-context', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('formatDuration', () => {
    it('should format zero duration', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('should format negative duration', () => {
      expect(formatDuration(-1000)).toBe('0s');
    });

    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
      expect(formatDuration(45000)).toBe('45s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(330000)).toBe('5m 30s');
    });

    it('should format hours and minutes', () => {
      expect(formatDuration(3900000)).toBe('1h 5m');
      expect(formatDuration(5400000)).toBe('1h 30m');
    });

    it('should format milliseconds less than 1 second', () => {
      expect(formatDuration(500)).toBe('0s');
    });
  });

  describe('TaskContext.create', () => {
    it('should create a task context file', async () => {
      const ctx = await TaskContext.create('test-task-1', tmpDir, {
        title: 'Test Task',
        chatId: 'oc_test',
      });

      expect(ctx).toBeDefined();
      expect(ctx.getTaskId()).toBe('test-task-1');
      expect(await ctx.exists()).toBe(true);

      const data = await ctx.read();
      expect(data).toBeDefined();
      expect(data!.title).toBe('Test Task');
      expect(data!.phase).toBe('pending');
      expect(data!.progress).toBe(0);
      expect(data!.chatId).toBe('oc_test');
    });

    it('should create with all options', async () => {
      const ctx = await TaskContext.create('test-task-2', tmpDir, {
        title: 'Full Task',
        description: 'A complete task description',
        chatId: 'oc_test',
        userId: 'user_123',
        maxIterations: 20,
      });

      const data = await ctx.read();
      expect(data!.description).toBe('A complete task description');
      expect(data!.userId).toBe('user_123');
      expect(data!.maxIterations).toBe(20);
    });

    it('should sanitize task ID for file path', async () => {
      const ctx = await TaskContext.create('cli-abc:123/def', tmpDir, {
        title: 'Sanitized Task',
        chatId: 'oc_test',
      });

      const contextPath = ctx.getContextPath();
      expect(contextPath).not.toContain(':');
      // Path should not contain unsanitized special chars
      expect(contextPath).not.toContain('cli-abc:123/def');
      expect(contextPath).toContain('cli-abc_123_def');
      expect(await ctx.exists()).toBe(true);
    });
  });

  describe('TaskContext.load', () => {
    it('should load an existing task context', async () => {
      await TaskContext.create('load-test', tmpDir, {
        title: 'Load Test',
        chatId: 'oc_test',
      });

      const ctx = await TaskContext.load('load-test', tmpDir);
      const data = await ctx.read();
      expect(data!.title).toBe('Load Test');
    });

    it('should throw for non-existent task', async () => {
      await expect(
        TaskContext.load('non-existent', tmpDir)
      ).rejects.toThrow('TaskContext not found');
    });
  });

  describe('TaskContext.tryLoad', () => {
    it('should return null for non-existent task', async () => {
      const ctx = await TaskContext.tryLoad('non-existent', tmpDir);
      expect(ctx).toBeNull();
    });

    it('should return context for existing task', async () => {
      await TaskContext.create('try-load-test', tmpDir, {
        title: 'Try Load Test',
        chatId: 'oc_test',
      });

      const ctx = await TaskContext.tryLoad('try-load-test', tmpDir);
      expect(ctx).not.toBeNull();
    });
  });

  describe('TaskContext.update', () => {
    it('should update phase', async () => {
      const ctx = await TaskContext.create('update-test', tmpDir, {
        title: 'Update Test',
        chatId: 'oc_test',
      });

      await ctx.setPhase('executing', 'Running task');
      const data = await ctx.read();
      expect(data!.phase).toBe('executing');
      expect(data!.currentActivity).toBe('Running task');
      expect(data!.startedAt).not.toBeNull();
    });

    it('should update progress', async () => {
      const ctx = await TaskContext.create('progress-test', tmpDir, {
        title: 'Progress Test',
        chatId: 'oc_test',
      });

      await ctx.setProgress(50, 'Halfway done');
      const data = await ctx.read();
      expect(data!.progress).toBe(50);
    });

    it('should clamp progress to 0-100', async () => {
      const ctx = await TaskContext.create('clamp-test', tmpDir, {
        title: 'Clamp Test',
        chatId: 'oc_test',
      });

      await ctx.setProgress(150);
      let data = await ctx.read();
      expect(data!.progress).toBe(100);

      await ctx.setProgress(-10);
      data = await ctx.read();
      expect(data!.progress).toBe(0);
    });

    it('should handle milestones', async () => {
      const ctx = await TaskContext.create('milestone-test', tmpDir, {
        title: 'Milestone Test',
        chatId: 'oc_test',
      });

      await ctx.setMilestone('Analysis', true);
      await ctx.setMilestone('Implementation', true);
      await ctx.setMilestone('Testing', false);

      const data = await ctx.read();
      expect(data!.milestones).toHaveLength(3);
      expect(data!.milestones[0].completed).toBe(true);
      expect(data!.milestones[0].completedAt).not.toBeNull();
      expect(data!.milestones[2].completed).toBe(false);
      // Progress should be auto-calculated: 2/3 = 67%
      expect(data!.progress).toBe(67);
    });
  });

  describe('TaskContext.complete / fail', () => {
    it('should mark task as completed', async () => {
      const ctx = await TaskContext.create('complete-test', tmpDir, {
        title: 'Complete Test',
        chatId: 'oc_test',
      });

      await ctx.setPhase('executing'); // Start the timer
      await ctx.complete('All done!');

      const data = await ctx.read();
      expect(data!.phase).toBe('completed');
      expect(data!.progress).toBe(100);
      expect(data!.etaMs).toBe(0);
    });

    it('should mark task as failed', async () => {
      const ctx = await TaskContext.create('fail-test', tmpDir, {
        title: 'Fail Test',
        chatId: 'oc_test',
      });

      await ctx.fail('Something went wrong');

      const data = await ctx.read();
      expect(data!.phase).toBe('failed');
      expect(data!.error).toBe('Something went wrong');
    });
  });

  describe('TaskContext.listActive', () => {
    it('should list only active tasks', async () => {
      await TaskContext.create('active-1', tmpDir, {
        title: 'Active Task 1',
        chatId: 'oc_test',
      });
      await TaskContext.create('active-2', tmpDir, {
        title: 'Active Task 2',
        chatId: 'oc_test',
      });
      const completed = await TaskContext.create('done-1', tmpDir, {
        title: 'Done Task',
        chatId: 'oc_test',
      });
      await completed.complete();

      const active = await TaskContext.listActive(tmpDir);
      expect(active).toHaveLength(2);
      expect(active.map(t => t.taskId)).toContain('active-1');
      expect(active.map(t => t.taskId)).toContain('active-2');
      expect(active.map(t => t.taskId)).not.toContain('done-1');
    });

    it('should return empty array when no tasks exist', async () => {
      const active = await TaskContext.listActive(tmpDir);
      expect(active).toHaveLength(0);
    });
  });

  describe('TaskContext.getFormattedStatus', () => {
    it('should return formatted status for active task', async () => {
      const ctx = await TaskContext.create('format-test', tmpDir, {
        title: 'Format Test',
        chatId: 'oc_test',
      });

      const status = await ctx.getFormattedStatus();
      expect(status).toContain('Format Test');
      expect(status).toContain('pending');
    });

    it('should return no task found for non-existent context', async () => {
      const ctx = await TaskContext.tryLoad('non-existent', tmpDir);
      expect(ctx).toBeNull();
    });
  });

  describe('TaskContext markdown round-trip', () => {
    it('should preserve all fields through write/read cycle', async () => {
      const ctx = await TaskContext.create('round-trip', tmpDir, {
        title: 'Round Trip Test',
        description: 'Testing data preservation',
        chatId: 'oc_test',
        userId: 'user_123',
        maxIterations: 5,
      });

      await ctx.setPhase('executing', 'Working');
      await ctx.setMilestone('Step 1', true);
      await ctx.setMilestone('Step 2', false);

      const data = await ctx.read();
      expect(data!.taskId).toBe('round-trip');
      expect(data!.title).toBe('Round Trip Test');
      expect(data!.description).toBe('Testing data preservation');
      expect(data!.phase).toBe('executing');
      expect(data!.maxIterations).toBe(5);
      expect(data!.userId).toBe('user_123');
      expect(data!.milestones).toHaveLength(2);
      expect(data!.currentActivity).toBe('Working');
    });
  });

  describe('TaskContext.toMarkdown / parseMarkdown', () => {
    it('should parse valid markdown', () => {
      const markdown = [
        '---',
        'task_id: "test-123"',
        'title: "Test Task"',
        'phase: executing',
        'iteration: 3',
        'max_iterations: 10',
        'progress: 30',
        'started_at: "2024-01-01T00:00:00.000Z"',
        'updated_at: "2024-01-01T00:10:00.000Z"',
        'elapsed_ms: 600000',
        'eta_ms: 1400000',
        'chat_id: "oc_test"',
        'user_id: "user_1"',
        'error: ""',
        '---',
        '',
        '# Task: Test Task',
        '',
        '## Description',
        '',
        'A test task',
        '',
        '## Current Activity',
        '',
        'Running tests',
        '',
        '## Milestones',
        '',
        '- ✅ Step 1 (2024-01-01T00:05:00.000Z)',
        '- ⬜ Step 2',
      ].join('\n');

      const data = TaskContext.parseMarkdown(markdown);
      expect(data).not.toBeNull();
      expect(data!.taskId).toBe('test-123');
      expect(data!.title).toBe('Test Task');
      expect(data!.phase).toBe('executing');
      expect(data!.iteration).toBe(3);
      expect(data!.progress).toBe(30);
      expect(data!.milestones).toHaveLength(2);
      expect(data!.milestones[0].completed).toBe(true);
      expect(data!.milestones[1].completed).toBe(false);
    });

    it('should return null for invalid markdown', () => {
      expect(TaskContext.parseMarkdown('no frontmatter')).toBeNull();
      expect(TaskContext.parseMarkdown('')).toBeNull();
    });
  });
});

describe('task-context-tools', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-tools-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTaskStatus', () => {
    it('should return no active tasks when empty', async () => {
      const result = await getTaskStatus({}, { workspaceDir: tmpDir });
      expect(result).toContain('No active tasks');
    });

    it('should return status for specific task', async () => {
      await TaskContext.create('status-test', tmpDir, {
        title: 'Status Test',
        chatId: 'oc_test',
      });

      const result = await getTaskStatus(
        { taskId: 'status-test' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('Status Test');
    });

    it('should return not found for non-existent task', async () => {
      const result = await getTaskStatus(
        { taskId: 'non-existent' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('not found');
    });

    it('should list all active tasks', async () => {
      await TaskContext.create('task-a', tmpDir, {
        title: 'Task A',
        chatId: 'oc_test',
      });
      await TaskContext.create('task-b', tmpDir, {
        title: 'Task B',
        chatId: 'oc_test',
      });

      const result = await getTaskStatus({}, { workspaceDir: tmpDir });
      expect(result).toContain('Task A');
      expect(result).toContain('Task B');
      expect(result).toContain('2 Active Task');
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task phase', async () => {
      await TaskContext.create('update-tool-test', tmpDir, {
        title: 'Update Tool Test',
        chatId: 'oc_test',
      });

      const result = await updateTaskStatus(
        { taskId: 'update-tool-test', phase: 'executing', currentActivity: 'Working' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('updated successfully');
      expect(result).toContain('executing');
    });

    it('should mark task as completed', async () => {
      await TaskContext.create('complete-tool-test', tmpDir, {
        title: 'Complete Tool Test',
        chatId: 'oc_test',
      });

      const result = await updateTaskStatus(
        { taskId: 'complete-tool-test', markCompleted: true },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('completed');
    });

    it('should mark task as failed', async () => {
      await TaskContext.create('fail-tool-test', tmpDir, {
        title: 'Fail Tool Test',
        chatId: 'oc_test',
      });

      const result = await updateTaskStatus(
        { taskId: 'fail-tool-test', markFailed: true, error: 'Test error' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('failed');
      expect(result).toContain('Test error');
    });

    it('should complete milestone', async () => {
      await TaskContext.create('milestone-tool-test', tmpDir, {
        title: 'Milestone Tool Test',
        chatId: 'oc_test',
      });

      const result = await updateTaskStatus(
        { taskId: 'milestone-tool-test', completeMilestone: 'Step 1' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('updated successfully');

      const ctx = await TaskContext.load('milestone-tool-test', tmpDir);
      const data = await ctx.read();
      expect(data!.milestones).toHaveLength(1);
      expect(data!.milestones[0].completed).toBe(true);
    });

    it('should return error for non-existent task', async () => {
      const result = await updateTaskStatus(
        { taskId: 'non-existent', phase: 'executing' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('not found');
    });
  });

  describe('createTaskContext', () => {
    it('should create a new task context', async () => {
      const result = await createTaskContext(
        'new-task',
        { title: 'New Task', chatId: 'oc_test' },
        { workspaceDir: tmpDir }
      );
      expect(result).toContain('created');
      expect(result).toContain('new-task');

      const ctx = await TaskContext.load('new-task', tmpDir);
      expect(await ctx.exists()).toBe(true);
    });
  });
});
