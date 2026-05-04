/**
 * Tests for TaskContext module.
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
  let taskContext: TaskContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
    taskContext = new TaskContext({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTaskContext', () => {
    it('returns null for non-existent task', async () => {
      const result = await taskContext.getTaskContext('non-existent');
      expect(result).toBeNull();
    });

    it('returns pending status for task with only task.md', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'test-task-1');
      await fs.mkdir(taskDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Fix timeout issue',
        '',
        '**Task ID**: test-task-1',
        '**Created**: 2026-05-01T10:00:00Z',
        '',
        '## Original Request',
        '',
        '```',
        'Fix the timeout in integration test',
        '```',
      ].join('\n'));

      const result = await taskContext.getTaskContext('test-task-1');

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('test-task-1');
      expect(result!.status).toBe('pending');
      expect(result!.title).toBe('Fix timeout issue');
      expect(result!.createdAt).toBe('2026-05-01T10:00:00Z');
      expect(result!.originalRequest).toBe('Fix the timeout in integration test');
      expect(result!.iterationsCompleted).toBe(0);
      expect(result!.currentPhase).toBeNull();
    });

    it('returns running status for task with iterations', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'test-task-2');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Running Task\n\n**Created**: 2026-05-01T10:00:00Z');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), 'Evaluation: NEED_EXECUTE');
      await fs.writeFile(path.join(iterDir, 'execution.md'), 'Executed fixes');

      const result = await taskContext.getTaskContext('test-task-2');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('running');
      expect(result!.iterationsCompleted).toBe(1);
    });

    it('returns completed status for task with final_result.md', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'test-task-3');
      await fs.mkdir(taskDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Completed Task\n\n**Created**: 2026-05-01T10:00:00Z');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), 'Task completed successfully');

      const result = await taskContext.getTaskContext('test-task-3');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
    });

    it('detects evaluation phase when iteration exists but no evaluation.md yet', async () => {
      // Iteration directory exists but no evaluation.md = evaluator is working
      const taskDir = path.join(tmpDir, 'tasks', 'test-task-4');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      const stepsDir = path.join(iterDir, 'steps');
      await fs.mkdir(stepsDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Phase Test');

      const result = await taskContext.getTaskContext('test-task-4');

      expect(result).not.toBeNull();
      expect(result!.currentPhase).toBe('evaluation');
    });

    it('detects execution phase when evaluation.md exists but execution.md does not', async () => {
      // evaluation.md exists = evaluator done, execution.md missing = executor working
      const taskDir = path.join(tmpDir, 'tasks', 'test-task-5');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Phase Test');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), 'Evaluation: NEED_EXECUTE');

      const result = await taskContext.getTaskContext('test-task-5');

      expect(result).not.toBeNull();
      expect(result!.currentPhase).toBe('execution');
    });

    it('handles sanitized task IDs', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'cli_123_456');
      await fs.mkdir(taskDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Sanitized ID');

      const result = await taskContext.getTaskContext('cli/123@456');
      expect(result).not.toBeNull();
    });
  });

  describe('getTaskSummary', () => {
    it('returns empty summary when no tasks exist', async () => {
      const summary = await taskContext.getTaskSummary();

      expect(summary.total).toBe(0);
      expect(summary.pending).toBe(0);
      expect(summary.running).toBe(0);
      expect(summary.completed).toBe(0);
      expect(summary.failed).toBe(0);
    });

    it('counts tasks by status', async () => {
      // Pending task
      const pendingDir = path.join(tmpDir, 'tasks', 'pending-1');
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, 'task.md'), '# Task: Pending');

      // Running task
      const runningDir = path.join(tmpDir, 'tasks', 'running-1');
      const runningIterDir = path.join(runningDir, 'iterations', 'iter-1');
      await fs.mkdir(runningIterDir, { recursive: true });
      await fs.writeFile(path.join(runningDir, 'task.md'), '# Task: Running');
      await fs.writeFile(path.join(runningIterDir, 'evaluation.md'), 'eval');

      // Completed task
      const completedDir = path.join(tmpDir, 'tasks', 'completed-1');
      await fs.mkdir(completedDir, { recursive: true });
      await fs.writeFile(path.join(completedDir, 'task.md'), '# Task: Completed');
      await fs.writeFile(path.join(completedDir, 'final_result.md'), 'Done');

      const summary = await taskContext.getTaskSummary();

      expect(summary.total).toBe(3);
      expect(summary.pending).toBe(1);
      expect(summary.running).toBe(1);
      expect(summary.completed).toBe(1);
      expect(summary.runningTaskIds).toContain('running-1');
    });
  });

  describe('listTasks', () => {
    it('returns all task IDs when no filter specified', async () => {
      for (const id of ['task-a', 'task-b', 'task-c']) {
        const taskDir = path.join(tmpDir, 'tasks', id);
        await fs.mkdir(taskDir, { recursive: true });
        await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: ${id}`);
      }

      const tasks = await taskContext.listTasks();
      expect(tasks).toHaveLength(3);
      expect(tasks).toContain('task-a');
    });

    it('filters by status', async () => {
      // Pending
      const pendingDir = path.join(tmpDir, 'tasks', 'pending-1');
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, 'task.md'), '# Task: Pending');

      // Completed
      const completedDir = path.join(tmpDir, 'tasks', 'completed-1');
      await fs.mkdir(completedDir, { recursive: true });
      await fs.writeFile(path.join(completedDir, 'task.md'), '# Task: Completed');
      await fs.writeFile(path.join(completedDir, 'final_result.md'), 'Done');

      const pendingTasks = await taskContext.listTasks({ status: 'pending' });
      expect(pendingTasks).toEqual(['pending-1']);

      const completedTasks = await taskContext.listTasks({ status: 'completed' });
      expect(completedTasks).toEqual(['completed-1']);
    });
  });

  describe('isRunning', () => {
    it('returns true for running tasks', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'running-1');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Running');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), 'eval');

      expect(await taskContext.isRunning('running-1')).toBe(true);
    });

    it('returns false for non-running tasks', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'pending-1');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Pending');

      expect(await taskContext.isRunning('pending-1')).toBe(false);
    });

    it('returns false for non-existent tasks', async () => {
      expect(await taskContext.isRunning('non-existent')).toBe(false);
    });
  });

  describe('with subdirectory', () => {
    it('uses subdirectory for task paths', async () => {
      const subContext = new TaskContext({ workspaceDir: tmpDir, subdirectory: 'schedules' });
      const taskDir = path.join(tmpDir, 'tasks', 'schedules', 'sched-1');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Scheduled Task\n\n**Created**: 2026-05-01T10:00:00Z');

      const result = await subContext.getTaskContext('sched-1');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Scheduled Task');
    });
  });
});
