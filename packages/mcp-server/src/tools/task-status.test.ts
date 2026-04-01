/**
 * Unit tests for task-status MCP tools.
 * Issue #857: Task status tracking for independent reporting Agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { detectTaskStatus } from './task-status.js';

// We need to mock getWorkspaceDir since we can't set up Config in tests
// Instead, we test detectTaskStatus directly and use a temp dir approach

describe('task-status', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-status-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('detectTaskStatus', () => {
    it('should return "pending" when only task.md exists', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');

      expect(detectTaskStatus(taskDir)).toBe('pending');
    });

    it('should return "completed" when final_result.md exists', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), 'Done!');

      expect(detectTaskStatus(taskDir)).toBe('completed');
    });

    it('should return "failed" when failed.md exists', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');
      await fs.writeFile(path.join(taskDir, 'failed.md'), 'Error occurred');

      expect(detectTaskStatus(taskDir)).toBe('failed');
    });

    it('should return "running" when running.lock exists', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');
      await fs.writeFile(path.join(taskDir, 'running.lock'), '');

      expect(detectTaskStatus(taskDir)).toBe('running');
    });

    it('should return "unknown" when no task.md exists', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });

      expect(detectTaskStatus(taskDir)).toBe('unknown');
    });

    it('should return "unknown" when directory does not exist', () => {
      expect(detectTaskStatus(path.join(tmpDir, 'nonexistent'))).toBe('unknown');
    });

    it('should prioritize completed over failed and running', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');
      await fs.writeFile(path.join(taskDir, 'running.lock'), '');
      await fs.writeFile(path.join(taskDir, 'failed.md'), 'Error');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), 'Done!');

      expect(detectTaskStatus(taskDir)).toBe('completed');
    });

    it('should prioritize failed over running', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');
      await fs.writeFile(path.join(taskDir, 'running.lock'), '');
      await fs.writeFile(path.join(taskDir, 'failed.md'), 'Error');

      expect(detectTaskStatus(taskDir)).toBe('failed');
    });
  });

  describe('list_tasks and get_task_status', () => {
    // We need to mock the getWorkspaceDir module
    // Since the tools import it, we test the logic by creating a realistic workspace

    it('should detect task status from file markers correctly', async () => {
      // Create a realistic task structure
      const tasksDir = path.join(tmpDir, 'tasks');

      // Task 1: pending
      const task1Dir = path.join(tasksDir, 'task_pending');
      await fs.mkdir(task1Dir, { recursive: true });
      await fs.writeFile(path.join(task1Dir, 'task.md'),
        '# Task: Fix login bug\n\n**Task ID**: msg_001\n**Created**: 2026-04-01T10:00:00Z\n**Chat ID**: oc_test\n\n## Original Request\n\n```\nFix the login bug\n```\n');

      // Task 2: running
      const task2Dir = path.join(tasksDir, 'task_running');
      await fs.mkdir(task2Dir, { recursive: true });
      await fs.writeFile(path.join(task2Dir, 'task.md'),
        '# Task: Add user feature\n\n**Task ID**: msg_002\n**Created**: 2026-04-01T11:00:00Z\n**Chat ID**: oc_test\n\n## Original Request\n\n```\nAdd user feature\n```\n');
      await fs.writeFile(path.join(task2Dir, 'running.lock'), '');
      // Add iterations
      const iter1Dir = path.join(task2Dir, 'iterations', 'iter-1');
      await fs.mkdir(iter1Dir, { recursive: true });
      await fs.writeFile(path.join(iter1Dir, 'evaluation.md'), 'Not complete yet');
      await fs.writeFile(path.join(iter1Dir, 'execution.md'), 'Working on it...');

      // Task 3: completed
      const task3Dir = path.join(tasksDir, 'task_completed');
      await fs.mkdir(task3Dir, { recursive: true });
      await fs.writeFile(path.join(task3Dir, 'task.md'),
        '# Task: Update docs\n\n**Task ID**: msg_003\n**Created**: 2026-04-01T09:00:00Z\n**Chat ID**: oc_test\n\n## Original Request\n\n```\nUpdate docs\n```\n');
      await fs.writeFile(path.join(task3Dir, 'final_result.md'), 'Docs updated successfully');
      const iter2Dir = path.join(task3Dir, 'iterations', 'iter-1');
      await fs.mkdir(iter2Dir, { recursive: true });
      await fs.writeFile(path.join(iter2Dir, 'evaluation.md'), 'Complete');
      await fs.writeFile(path.join(iter2Dir, 'execution.md'), 'Done');

      // Verify status detection
      expect(detectTaskStatus(task1Dir)).toBe('pending');
      expect(detectTaskStatus(task2Dir)).toBe('running');
      expect(detectTaskStatus(task3Dir)).toBe('completed');
    });

    it('should handle empty task.md gracefully', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '');

      expect(detectTaskStatus(taskDir)).toBe('pending');
    });

    it('should handle task.md with only title (no Task ID prefix)', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# My Custom Title\nSome content here');

      expect(detectTaskStatus(taskDir)).toBe('pending');
    });

    it('should handle non-existent iterations directory', async () => {
      const taskDir = path.join(tmpDir, 'test-task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n');

      // Verify the task is pending even without iterations dir
      expect(detectTaskStatus(taskDir)).toBe('pending');
    });
  });
});
