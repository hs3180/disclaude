/**
 * Task Context Reader - Unit tests.
 *
 * @module task/task-context.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskContextReader } from './task-context.js';

describe('TaskContextReader', () => {
  let workspaceDir: string;
  let reader: TaskContextReader;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
    reader = new TaskContextReader({ workspaceDir });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe('readTaskContext', () => {
    it('should return null for non-existent task', async () => {
      const ctx = await reader.readTaskContext('non-existent-task');
      expect(ctx).toBeNull();
    });

    it('should read task spec with all metadata fields', async () => {
      // Create task directory and task.md
      const taskDir = path.join(workspaceDir, 'tasks', 'test_task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Implement user authentication',
        '',
        '**Task ID**: test_task',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_test123',
        '**User ID**: ou_test456',
        '',
        '## Original Request',
        '',
        '```',
        'Add JWT authentication to the API',
        '```',
      ].join('\n'));

      const ctx = await reader.readTaskContext('test_task');
      expect(ctx).not.toBeNull();
      expect(ctx!.taskId).toBe('test_task');
      expect(ctx!.title).toBe('Implement user authentication');
      expect(ctx!.description).toBe('Add JWT authentication to the API');
      expect(ctx!.chatId).toBe('oc_test123');
      expect(ctx!.createdAt).toBe('2026-04-04T00:00:00Z');
      expect(ctx!.userId).toBe('ou_test456');
      expect(ctx!.currentIteration).toBe(0);
      expect(ctx!.totalIterations).toBe(0);
      expect(ctx!.isComplete).toBe(false);
      expect(ctx!.hasFinalResult).toBe(false);
    });

    it('should read task with iterations, evaluation, and execution', async () => {
      // Create full task structure
      const taskDir = path.join(workspaceDir, 'tasks', 'task_with_iters');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Fix login bug',
        '',
        '**Task ID**: task_with_iters',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat1',
        '',
        '## Original Request',
        '',
        '```',
        'Login page crashes on empty password',
        '```',
      ].join('\n'));

      await fs.writeFile(path.join(iterDir, 'evaluation.md'), [
        '# Evaluation: Iteration 1',
        '',
        '## Status',
        'NEED_EXECUTE',
        '',
        '## Assessment',
        'First iteration, no code changes yet.',
        '',
        '## Next Actions',
        '- Add null check for password field',
        '- Write unit test',
      ].join('\n'));

      await fs.writeFile(path.join(iterDir, 'execution.md'), [
        '# Execution: Iteration 1',
        '',
        '**Timestamp**: 2026-04-04T00:05:00Z',
        '**Status**: Completed',
        '',
        '## Summary',
        'Added null check for password field in login handler.',
        '',
        '## Changes Made',
        '- Added password validation',
        '',
        '## Files Modified',
        '- src/auth/login.ts',
        '- src/auth/login.test.ts',
      ].join('\n'));

      const ctx = await reader.readTaskContext('task_with_iters');
      expect(ctx).not.toBeNull();
      expect(ctx!.currentIteration).toBe(1);
      expect(ctx!.totalIterations).toBe(1);
      expect(ctx!.latestEvaluationStatus).toBe('NEED_EXECUTE');
      expect(ctx!.latestAssessment).toBe('First iteration, no code changes yet.');
      expect(ctx!.latestNextActions).toEqual([
        'Add null check for password field',
        'Write unit test',
      ]);
      expect(ctx!.latestExecutionSummary).toBe('Added null check for password field in login handler.');
      expect(ctx!.latestFilesModified).toEqual([
        'src/auth/login.ts',
        'src/auth/login.test.ts',
      ]);
      expect(ctx!.isComplete).toBe(false);
      expect(ctx!.latestEvaluationPath).not.toBeNull();
      expect(ctx!.latestExecutionPath).not.toBeNull();
    });

    it('should detect complete task via evaluation status', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'completed_task');
      const iterDir = path.join(taskDir, 'iterations', 'iter-2');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Add logging',
        '',
        '**Task ID**: completed_task',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat2',
        '',
        '## Original Request',
        '',
        '```',
        'Add request logging middleware',
        '```',
      ].join('\n'));

      await fs.writeFile(path.join(iterDir, 'evaluation.md'), [
        '# Evaluation: Iteration 2',
        '',
        '## Status',
        'COMPLETE',
        '',
        '## Assessment',
        'All expected results satisfied.',
      ].join('\n'));

      const ctx = await reader.readTaskContext('completed_task');
      expect(ctx).not.toBeNull();
      expect(ctx!.latestEvaluationStatus).toBe('COMPLETE');
      expect(ctx!.isComplete).toBe(true);
    });

    it('should detect complete task via final_result.md', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'final_result_task');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Refactor API',
        '**Task ID**: final_result_task',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat3',
        '',
        '## Original Request',
        '',
        '```',
        'Refactor API endpoints',
        '```',
      ].join('\n'));

      await fs.writeFile(path.join(taskDir, 'final_result.md'), '# Final Result\n\nTask completed.');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), [
        '# Evaluation: Iteration 1',
        '## Status',
        'NEED_EXECUTE',
      ].join('\n'));

      const ctx = await reader.readTaskContext('final_result_task');
      expect(ctx).not.toBeNull();
      expect(ctx!.hasFinalResult).toBe(true);
      expect(ctx!.isComplete).toBe(true);
    });

    it('should read the latest iteration when multiple exist', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'multi_iter');
      const iter1Dir = path.join(taskDir, 'iterations', 'iter-1');
      const iter2Dir = path.join(taskDir, 'iterations', 'iter-2');
      const iter3Dir = path.join(taskDir, 'iterations', 'iter-3');
      await fs.mkdir(iter1Dir, { recursive: true });
      await fs.mkdir(iter2Dir, { recursive: true });
      await fs.mkdir(iter3Dir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Multi iteration task',
        '**Task ID**: multi_iter',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat4',
        '',
        '## Original Request',
        '',
        '```',
        'Complex task requiring multiple iterations',
        '```',
      ].join('\n'));

      // Create evaluations for each iteration
      for (const [dir, status] of [[iter1Dir, 'NEED_EXECUTE'], [iter2Dir, 'NEED_EXECUTE'], [iter3Dir, 'NEED_EXECUTE']] as const) {
        await fs.writeFile(path.join(dir, 'evaluation.md'), [
          '# Evaluation: Iteration',
          '## Status',
          status,
          '## Assessment',
          `Assessment for ${path.basename(dir)}`,
        ].join('\n'));
      }

      const ctx = await reader.readTaskContext('multi_iter');
      expect(ctx).not.toBeNull();
      expect(ctx!.totalIterations).toBe(3);
      expect(ctx!.currentIteration).toBe(3);
      expect(ctx!.latestAssessment).toBe('Assessment for iter-3');
    });

    it('should handle missing evaluation gracefully', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'no_eval');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: No eval task',
        '**Task ID**: no_eval',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat5',
        '',
        '## Original Request',
        '',
        '```',
        'Task without evaluation',
        '```',
      ].join('\n'));

      // No evaluation.md or execution.md in iter-1

      const ctx = await reader.readTaskContext('no_eval');
      expect(ctx).not.toBeNull();
      expect(ctx!.latestEvaluationStatus).toBe('UNKNOWN');
      expect(ctx!.latestAssessment).toBeNull();
      expect(ctx!.latestExecutionSummary).toBeNull();
      expect(ctx!.latestFilesModified).toEqual([]);
    });
  });

  describe('getProgressSummary', () => {
    it('should return null for non-existent task', async () => {
      const summary = await reader.getProgressSummary('non-existent');
      expect(summary).toBeNull();
    });

    it('should show waiting status for task with no iterations', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'waiting_task');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Waiting task',
        '**Task ID**: waiting_task',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat6',
      ].join('\n'));

      const summary = await reader.getProgressSummary('waiting_task');
      expect(summary).toContain('⏳');
      expect(summary).toContain('等待执行');
      expect(summary).toContain('Waiting task');
    });

    it('should show running status for active task', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'running_task');
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Running task',
        '**Task ID**: running_task',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat7',
      ].join('\n'));

      await fs.writeFile(path.join(iterDir, 'evaluation.md'), [
        '# Evaluation: Iteration 1',
        '## Status',
        'NEED_EXECUTE',
      ].join('\n'));

      const summary = await reader.getProgressSummary('running_task');
      expect(summary).toContain('🔄');
      expect(summary).toContain('执行中');
      expect(summary).toContain('1/1');
    });

    it('should show completed status', async () => {
      const taskDir = path.join(workspaceDir, 'tasks', 'done_task');
      const iter1Dir = path.join(taskDir, 'iterations', 'iter-1');
      const iter2Dir = path.join(taskDir, 'iterations', 'iter-2');
      await fs.mkdir(iter1Dir, { recursive: true });
      await fs.mkdir(iter2Dir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), [
        '# Task: Done task',
        '**Task ID**: done_task',
        '**Created**: 2026-04-04T00:00:00Z',
        '**Chat ID**: oc_chat8',
      ].join('\n'));

      await fs.writeFile(path.join(iter1Dir, 'evaluation.md'), [
        '# Evaluation: Iteration 1',
        '## Status',
        'NEED_EXECUTE',
      ].join('\n'));

      await fs.writeFile(path.join(iter2Dir, 'evaluation.md'), [
        '# Evaluation: Iteration 2',
        '## Status',
        'COMPLETE',
      ].join('\n'));

      const summary = await reader.getProgressSummary('done_task');
      expect(summary).toContain('✅');
      expect(summary).toContain('已完成');
      expect(summary).toContain('2 次迭代');
    });
  });

  describe('listActiveTasks', () => {
    it('should return empty array for empty workspace', async () => {
      const tasks = await reader.listActiveTasks();
      expect(tasks).toEqual([]);
    });

    it('should list only active (non-complete) tasks', async () => {
      // Create 3 tasks: active, complete, active
      for (const [taskId, isComplete] of [['active1', false], ['complete1', true], ['active2', false]] as const) {
        const taskDir = path.join(workspaceDir, 'tasks', taskId);
        await fs.mkdir(taskDir, { recursive: true });
        await fs.writeFile(path.join(taskDir, 'task.md'), [
          `# Task: ${taskId}`,
          `**Task ID**: ${taskId}`,
          '**Created**: 2026-04-04T00:00:00Z',
          '**Chat ID**: oc_chat',
        ].join('\n'));

        if (isComplete) {
          await fs.writeFile(path.join(taskDir, 'final_result.md'), '# Final Result\nDone.');
        }
      }

      const tasks = await reader.listActiveTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks).toContain('active1');
      expect(tasks).toContain('active2');
      expect(tasks).not.toContain('complete1');
    });
  });
});
