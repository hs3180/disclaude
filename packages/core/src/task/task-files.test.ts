/**
 * Unit tests for TaskFileManager.getTaskStatus and TaskFileManager.listAllTasks
 * Issue #857: Task progress reporting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskFileManager } from './task-files.js';

describe('TaskFileManager - getTaskStatus', () => {
  let tmpDir: string;
  let fileManager: TaskFileManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-files-test-'));
    fileManager = new TaskFileManager({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTaskStatus', () => {
    it('should return not_found for non-existent task', async () => {
      const status = await fileManager.getTaskStatus('non_existent_task');

      expect(status.status).toBe('not_found');
      expect(status.taskId).toBe('non_existent_task');
      expect(status.title).toBeNull();
      expect(status.totalIterations).toBe(0);
      expect(status.isRunning).toBe(false);
      expect(status.hasFinalResult).toBe(false);
    });

    it('should return pending for task with only task.md', async () => {
      await fileManager.initializeTask('test_task');
      await fileManager.writeTaskSpec('test_task', `# Task: Test Task

**Created**: 2026-03-28T10:00:00.000Z

## Description

This is a test task description.
`);

      const status = await fileManager.getTaskStatus('test_task');

      expect(status.status).toBe('pending');
      expect(status.title).toBe('Task: Test Task');
      expect(status.description).toContain('This is a test task description');
      expect(status.isRunning).toBe(false);
      expect(status.hasFinalResult).toBe(false);
      expect(status.totalIterations).toBe(0);
      expect(status.createdAt).toBe('2026-03-28T10:00:00.000Z');
    });

    it('should return running when running.lock exists', async () => {
      await fileManager.initializeTask('running_task');
      await fileManager.writeTaskSpec('running_task', '# Task: Running Task\n\n**Created**: 2026-03-28T10:00:00.000Z\n');

      // Create running.lock
      const lockPath = path.join(fileManager.getTaskDir('running_task'), 'running.lock');
      await fs.writeFile(lockPath, '', 'utf-8');

      const status = await fileManager.getTaskStatus('running_task');

      expect(status.status).toBe('running');
      expect(status.isRunning).toBe(true);
    });

    it('should return completed when final_result.md exists', async () => {
      await fileManager.initializeTask('completed_task');
      await fileManager.writeTaskSpec('completed_task', '# Task: Completed Task\n\n**Created**: 2026-03-28T10:00:00.000Z\n');

      // Create final_result.md
      const resultPath = path.join(fileManager.getTaskDir('completed_task'), 'final_result.md');
      await fs.writeFile(resultPath, 'Task completed successfully', 'utf-8');

      const status = await fileManager.getTaskStatus('completed_task');

      expect(status.status).toBe('completed');
      expect(status.hasFinalResult).toBe(true);
    });

    it('should return failed when failed.md exists', async () => {
      await fileManager.initializeTask('failed_task');
      await fileManager.writeTaskSpec('failed_task', '# Task: Failed Task\n\n**Created**: 2026-03-28T10:00:00.000Z\n');

      // Create failed.md
      const failedPath = path.join(fileManager.getTaskDir('failed_task'), 'failed.md');
      await fs.writeFile(failedPath, 'Task failed due to timeout', 'utf-8');

      const status = await fileManager.getTaskStatus('failed_task');

      expect(status.status).toBe('failed');
    });

    it('should report iteration count correctly', async () => {
      await fileManager.initializeTask('iter_task');
      await fileManager.writeTaskSpec('iter_task', '# Task: Iteration Task\n\n**Created**: 2026-03-28T10:00:00.000Z\n');

      // Create 3 iterations
      await fileManager.createIteration('iter_task', 1);
      await fileManager.createIteration('iter_task', 2);
      await fileManager.createIteration('iter_task', 3);

      const status = await fileManager.getTaskStatus('iter_task');

      expect(status.totalIterations).toBe(3);
      expect(status.latestIteration).toBe(3);
    });

    it('should prioritize completed > failed > running > pending', async () => {
      // completed has final_result.md (highest priority)
      await fileManager.initializeTask('priority_task');
      await fileManager.writeTaskSpec('priority_task', '# Task: Priority Task\n');
      await fs.writeFile(
        path.join(fileManager.getTaskDir('priority_task'), 'final_result.md'),
        'done', 'utf-8'
      );
      await fs.writeFile(
        path.join(fileManager.getTaskDir('priority_task'), 'running.lock'),
        '', 'utf-8'
      );
      await fs.writeFile(
        path.join(fileManager.getTaskDir('priority_task'), 'failed.md'),
        '', 'utf-8'
      );

      const status = await fileManager.getTaskStatus('priority_task');
      // completed takes priority over running and failed
      expect(status.status).toBe('completed');
    });

    it('should include elapsed time', async () => {
      await fileManager.initializeTask('timed_task');
      await fileManager.writeTaskSpec('timed_task', '# Task: Timed Task\n\n**Created**: 2026-03-28T10:00:00.000Z\n');

      const status = await fileManager.getTaskStatus('timed_task');

      expect(status.elapsedSeconds).not.toBeNull();
      expect(status.elapsedSeconds).toBeGreaterThanOrEqual(0);
      expect(status.lastModified).not.toBeNull();
    });

    it('should handle missing task.md gracefully', async () => {
      await fileManager.initializeTask('no_spec_task');
      // Don't write task.md

      const status = await fileManager.getTaskStatus('no_spec_task');

      expect(status.status).toBe('pending');
      expect(status.title).toBeNull();
      expect(status.description).toBeNull();
    });

    it('should handle taskId with special characters', async () => {
      await fileManager.initializeTask('om_abc-123_test');
      await fileManager.writeTaskSpec('om_abc-123_test', '# Task: Special ID Task\n');

      const status = await fileManager.getTaskStatus('om_abc-123_test');

      expect(status.status).toBe('pending');
    });
  });

  describe('listAllTasks', () => {
    it('should return empty array for empty tasks directory', async () => {
      const tasks = await fileManager.listAllTasks();
      expect(tasks).toEqual([]);
    });

    it('should list tasks that have task.md', async () => {
      await fileManager.initializeTask('task_a');
      await fileManager.writeTaskSpec('task_a', '# Task A\n');

      await fileManager.initializeTask('task_b');
      await fileManager.writeTaskSpec('task_b', '# Task B\n');

      const tasks = await fileManager.listAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks).toContain('task_a');
      expect(tasks).toContain('task_b');
    });

    it('should skip directories without task.md', async () => {
      await fileManager.initializeTask('valid_task');
      await fileManager.writeTaskSpec('valid_task', '# Valid Task\n');

      // Create a directory without task.md
      const invalidDir = path.join(tmpDir, 'tasks', 'invalid_task');
      await fs.mkdir(invalidDir, { recursive: true });

      const tasks = await fileManager.listAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks).toContain('valid_task');
    });

    it('should return non-empty tasks directory', async () => {
      // Ensure base directory exists
      await fs.mkdir(path.join(tmpDir, 'tasks'), { recursive: true });

      const tasks = await fileManager.listAllTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });
});
