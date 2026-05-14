/**
 * Tests for TaskStatusProvider.
 *
 * Verifies task status reading from the filesystem.
 *
 * Issue #857: Task progress reporting foundation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskStatusProvider, TaskState } from './task-status.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-status-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskStatusProvider', () => {
  let provider: TaskStatusProvider;

  beforeEach(() => {
    provider = new TaskStatusProvider(tempDir);
  });

  describe('getTaskStatus', () => {
    it('should return undefined for non-existent task', async () => {
      const status = await provider.getTaskStatus('nonexistent');
      expect(status).toBeUndefined();
    });

    it('should return PENDING state for task with no iterations', async () => {
      const taskId = 'test-task-1';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Test task\n\n**Task ID**: ${taskId}\n**Created**: 2026-01-01T00:00:00Z\n`,
        'utf-8'
      );

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.taskId).toBe(taskId);
      expect(status!.state).toBe(TaskState.PENDING);
      expect(status!.totalIterations).toBe(0);
      expect(status!.title).toBe('Task: Test task');
      expect(status!.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(status!.hasFinalResult).toBe(false);
    });

    it('should return RUNNING state for task with iterations', async () => {
      const taskId = 'test-task-2';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.state).toBe(TaskState.RUNNING);
      expect(status!.totalIterations).toBe(1);
    });

    it('should return FINALIZED state when final_result.md exists', async () => {
      const taskId = 'test-task-3';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'final_result.md'), 'Done', 'utf-8');

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.state).toBe(TaskState.FINALIZED);
      expect(status!.hasFinalResult).toBe(true);
    });

    it('should report iteration details correctly', async () => {
      const taskId = 'test-task-4';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      const stepsDir = path.join(iterDir, 'steps');
      await fs.mkdir(stepsDir, { recursive: true });

      await fs.writeFile(path.join(iterDir, 'evaluation.md'), 'eval', 'utf-8');
      await fs.writeFile(path.join(iterDir, 'execution.md'), 'exec', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'step-1.md'), 'step1', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'step-2.md'), 'step2', 'utf-8');

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.iterations).toHaveLength(1);
      expect(status!.iterations[0]).toEqual({
        iteration: 1,
        hasEvaluation: true,
        hasExecution: true,
        stepCount: 2,
      });
    });

    it('should handle multiple iterations', async () => {
      const taskId = 'test-task-5';
      const taskDir = path.join(tempDir, 'tasks', taskId);

      for (let i = 1; i <= 3; i++) {
        const iterDir = path.join(taskDir, 'iterations', `iter-${i}`);
        await fs.mkdir(iterDir, { recursive: true });
        await fs.writeFile(path.join(iterDir, 'evaluation.md'), `eval-${i}`, 'utf-8');
      }

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.totalIterations).toBe(3);
      expect(status!.iterations).toHaveLength(3);
      expect(status!.iterations[0].iteration).toBe(1);
      expect(status!.iterations[2].iteration).toBe(3);
    });

    it('should sanitize task ID with special characters', async () => {
      const taskId = 'msg/123@abc';
      const sanitized = 'msg_123_abc';
      const taskDir = path.join(tempDir, 'tasks', sanitized);
      await fs.mkdir(taskDir, { recursive: true });

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.taskId).toBe(sanitized);
    });

    it('should detect final-summary.md', async () => {
      const taskId = 'test-task-6';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations');
      await fs.mkdir(iterDir, { recursive: true });
      await fs.writeFile(path.join(iterDir, 'final-summary.md'), 'summary', 'utf-8');

      const status = await provider.getTaskStatus(taskId);
      expect(status).toBeDefined();
      expect(status!.hasFinalSummary).toBe(true);
    });
  });

  describe('listTasks', () => {
    it('should return empty array when no tasks exist', async () => {
      const tasks = await provider.listTasks();
      expect(tasks).toEqual([]);
    });

    it('should list all tasks', async () => {
      for (const taskId of ['task-a', 'task-b', 'task-c']) {
        const taskDir = path.join(tempDir, 'tasks', taskId);
        await fs.mkdir(taskDir, { recursive: true });
        await fs.writeFile(
          path.join(taskDir, 'task.md'),
          `# Task: ${taskId}\n`,
          'utf-8'
        );
      }

      const tasks = await provider.listTasks();
      expect(tasks).toHaveLength(3);
      const ids = tasks.map(t => t.taskId).sort();
      expect(ids).toEqual(['task-a', 'task-b', 'task-c']);
    });

    it('should include correct summary info', async () => {
      const taskId = 'summary-task';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        '# Task: Summary Test\n',
        'utf-8'
      );

      const tasks = await provider.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskId).toBe(taskId);
      expect(tasks[0].state).toBe(TaskState.RUNNING);
      expect(tasks[0].totalIterations).toBe(1);
      expect(tasks[0].title).toBe('Task: Summary Test');
    });

    it('should ignore non-directory entries', async () => {
      const tasksDir = path.join(tempDir, 'tasks');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, 'readme.txt'), 'not a task', 'utf-8');

      const tasks = await provider.listTasks();
      expect(tasks).toEqual([]);
    });
  });
});
