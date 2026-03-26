/**
 * Unit tests for TaskStatusReader
 *
 * Issue #857: Tests for the task status reading functionality
 * that provides context for the Reporter Agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskStatusReader } from './task-status.js';

describe('TaskStatusReader', () => {
  let reader: TaskStatusReader;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-status-test-'));
    reader = new TaskStatusReader({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTaskStatus', () => {
    it('should return unknown status for non-existent task', async () => {
      const status = await reader.getTaskStatus('non-existent-task');
      expect(status.status).toBe('unknown');
      expect(status.taskId).toBe('non-existent-task');
      expect(status.title).toBe('Unknown Task');
    });

    it('should return created status for task with only task.md', async () => {
      const taskId = 'test-task-1';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Test Feature

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z
**Chat ID**: oc_test123

## Description

Implement a new feature for testing.
`);

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('created');
      expect(status.title).toBe('Test Feature');
      expect(status.chatId).toBe('oc_test123');
      expect(status.createdAt).toBe('2026-03-27T10:00:00.000Z');
      expect(status.currentIteration).toBe(0);
      expect(status.totalIterations).toBe(0);
      expect(status.hasFinalResult).toBe(false);
    });

    it('should return iterating status for task with iterations', async () => {
      const taskId = 'test-task-2';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1', 'steps');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Bug Fix

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z
**Chat ID**: oc_test456

## Description

Fix a critical bug.
`);

      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-1', 'evaluation.md'),
        '# Evaluation\n\nTask is partially complete. Need to continue.'
      );

      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-1', 'execution.md'),
        '# Execution\n\nFixed the main issue, tests passing.'
      );

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('iterating');
      expect(status.title).toBe('Bug Fix');
      expect(status.currentIteration).toBe(1);
      expect(status.totalIterations).toBe(1);
      expect(status.hasFinalResult).toBe(false);
      expect(status.latestEvaluationSummary).toContain('partially complete');
      expect(status.latestExecutionSummary).toContain('Fixed the main issue');
    });

    it('should return completed status when final_result.md exists', async () => {
      const taskId = 'test-task-3';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1', 'steps');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Feature Complete

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

A completed feature.
`);

      await fs.writeFile(path.join(taskDir, 'final_result.md'), '# Final Result\n\nTask completed successfully.');

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('completed');
      expect(status.hasFinalResult).toBe(true);
      expect(status.title).toBe('Feature Complete');
    });

    it('should return error status when evaluation indicates failure', async () => {
      const taskId = 'test-task-4';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1', 'steps');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Failing Task

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

A task that encountered an error.
`);

      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-1', 'evaluation.md'),
        '# Evaluation\n\nThe task failed due to a critical error.'
      );

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('error');
      expect(status.latestEvaluationSummary).toContain('failed');
    });

    it('should handle Chinese error keywords', async () => {
      const taskId = 'test-task-cn';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1', 'steps');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: 中文任务

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

测试中文错误检测。
`);

      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-1', 'evaluation.md'),
        '# 评估\n\n任务执行失败，需要重试。'
      );

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('error');
    });

    it('should detect hasFinalSummary', async () => {
      const taskId = 'test-task-summary';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1', 'steps');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Summary Test

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

Test final summary detection.
`);

      await fs.writeFile(
        path.join(taskDir, 'iterations', 'final-summary.md'),
        '# Final Summary\n\nAll done.'
      );

      const status = await reader.getTaskStatus(taskId);
      expect(status.hasFinalSummary).toBe(true);
    });

    it('should handle multiple iterations and report the latest', async () => {
      const taskId = 'test-task-multi';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-1', 'steps'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-2', 'steps'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-3', 'steps'), { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Multi Iteration

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

A task with multiple iterations.
`);

      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-1', 'evaluation.md'),
        'First evaluation - needs more work'
      );
      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-2', 'evaluation.md'),
        'Second evaluation - getting closer'
      );
      await fs.writeFile(
        path.join(taskDir, 'iterations', 'iter-3', 'evaluation.md'),
        'Third evaluation - almost there'
      );

      const status = await reader.getTaskStatus(taskId);
      expect(status.totalIterations).toBe(3);
      expect(status.currentIteration).toBe(3);
      expect(status.latestEvaluationSummary).toContain('almost there');
    });

    it('should extract description from Original Request section', async () => {
      const taskId = 'test-task-desc';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Description Test

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Original Request

Please implement a feature that allows users to upload files
and process them in the background.
`);

      const status = await reader.getTaskStatus(taskId);
      expect(status.description).toContain('implement a feature');
    });

    it('should include updatedAt timestamp', async () => {
      const taskId = 'test-task-time';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Time Test

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

Test updatedAt.
`);

      const status = await reader.getTaskStatus(taskId);
      expect(status.updatedAt).toBeTruthy();
      // Should be a valid ISO date
      expect(() => new Date(status.updatedAt)).not.toThrow();
    });
  });

  describe('listTaskIds', () => {
    it('should return empty array for empty workspace', async () => {
      const taskIds = await reader.listTaskIds();
      expect(taskIds).toEqual([]);
    });

    it('should list all task directories', async () => {
      await fs.mkdir(path.join(tmpDir, 'tasks', 'task-a'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'tasks', 'task-b'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'tasks', 'task-c'), { recursive: true });

      const taskIds = await reader.listTaskIds();
      expect(taskIds).toHaveLength(3);
      expect(taskIds).toContain('task-a');
      expect(taskIds).toContain('task-b');
      expect(taskIds).toContain('task-c');
    });
  });

  describe('edge cases', () => {
    it('should handle task.md with missing metadata gracefully', async () => {
      const taskId = 'test-task-minimal';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), `Some plain content without proper structure.`);

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('created');
      expect(status.title).toBe('Untitled Task');
      expect(status.chatId).toBe('');
      expect(status.createdAt).toBe('');
    });

    it('should handle corrupted task.md gracefully', async () => {
      const taskId = 'test-task-corrupt';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      // Write binary-ish content
      await fs.writeFile(path.join(taskDir, 'task.md'), '\x00\x01\x02');

      const status = await reader.getTaskStatus(taskId);
      expect(status.status).toBe('created');
    });

    it('should truncate long descriptions', async () => {
      const taskId = 'test-task-long';
      const taskDir = path.join(tmpDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const longDescription = 'A'.repeat(1000);
      await fs.writeFile(path.join(taskDir, 'task.md'), `# Task: Long Description

**Task ID**: ${taskId}
**Created**: 2026-03-27T10:00:00.000Z

## Description

${longDescription}
`);

      const status = await reader.getTaskStatus(taskId);
      expect(status.description.length).toBeLessThanOrEqual(500);
    });
  });
});
