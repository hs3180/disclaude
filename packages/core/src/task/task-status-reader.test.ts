/**
 * Unit tests for TaskStatusReader
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskStatusReader } from './task-status-reader.js';

describe('TaskStatusReader', () => {
  let reader: TaskStatusReader;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-status-test-'));
    reader = new TaskStatusReader(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTaskStatus', () => {
    it('should return null for non-existent task', async () => {
      const status = await reader.getTaskStatus('non-existent');
      expect(status).toBeNull();
    });

    it('should read status from a running task with task.md', async () => {
      // Create task directory and task.md
      const taskDir = path.join(tmpDir, 'tasks', 'om_abc123');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Fix login bug

**Task ID**: om_abc123
**Created**: 2026-03-29T10:00:00Z
**Chat ID**: oc_test123
**User ID**: user_001

## Original Request

\`\`\`
Fix the login bug in auth.service.ts
\`\`\`
`,
        'utf-8'
      );

      const status = await reader.getTaskStatus('om_abc123');

      expect(status).not.toBeNull();
      expect(status!.taskId).toBe('om_abc123');
      expect(status!.status).toBe('running');
      expect(status!.title).toBe('Fix login bug');
      expect(status!.chatId).toBe('oc_test123');
      expect(status!.createdAt).toBe('2026-03-29T10:00:00Z');
      expect(status!.description).toBe('Fix the login bug in auth.service.ts');
      expect(status!.totalIterations).toBe(0);
      expect(status!.latestIteration).toBe(0);
      expect(status!.hasFinalResult).toBe(false);
      expect(status!.hasLatestEvaluation).toBe(false);
      expect(status!.hasLatestExecution).toBe(false);
    });

    it('should detect completed tasks with final_result.md', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_done');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Completed task

**Task ID**: om_done
**Created**: 2026-03-29T10:00:00Z
**Chat ID**: oc_chat

## Original Request

\`\`\`
Do something
\`\`\`
`,
        'utf-8'
      );
      await fs.writeFile(
        path.join(taskDir, 'final_result.md'),
        '# Result\n\nTask completed successfully.',
        'utf-8'
      );

      const status = await reader.getTaskStatus('om_done');

      expect(status).not.toBeNull();
      expect(status!.status).toBe('completed');
      expect(status!.hasFinalResult).toBe(true);
    });

    it('should count iterations correctly', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_iter');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Multi-iteration task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest task\n\`\`\`\n`,
        'utf-8'
      );

      // Create 3 iterations
      for (let i = 1; i <= 3; i++) {
        const iterDir = path.join(taskDir, 'iterations', `iter-${i}`);
        await fs.mkdir(iterDir, { recursive: true });
        await fs.writeFile(
          path.join(iterDir, 'evaluation.md'),
          `Evaluation ${i}`,
          'utf-8'
        );
        await fs.writeFile(
          path.join(iterDir, 'execution.md'),
          `Execution ${i}`,
          'utf-8'
        );
      }

      const status = await reader.getTaskStatus('om_iter');

      expect(status).not.toBeNull();
      expect(status!.totalIterations).toBe(3);
      expect(status!.latestIteration).toBe(3);
      expect(status!.hasLatestEvaluation).toBe(true);
      expect(status!.hasLatestExecution).toBe(true);
    });

    it('should detect partial iterations (execution without evaluation)', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_partial');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Partial task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );

      // Create iteration with only execution
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });
      await fs.writeFile(
        path.join(iterDir, 'execution.md'),
        'Execution done',
        'utf-8'
      );

      const status = await reader.getTaskStatus('om_partial');

      expect(status).not.toBeNull();
      expect(status!.totalIterations).toBe(1);
      expect(status!.latestIteration).toBe(1);
      expect(status!.hasLatestExecution).toBe(true);
      expect(status!.hasLatestEvaluation).toBe(false);
    });

    it('should sanitize task IDs with special characters', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_test_special_chars');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Sanitized ID test\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );

      // Use an ID with special characters
      const status = await reader.getTaskStatus('om/test@special#chars');
      expect(status).not.toBeNull();
      expect(status!.title).toBe('Sanitized ID test');
    });

    it('should detect final-summary.md', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_summary');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Task: Summary test\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );
      await fs.mkdir(path.join(taskDir, 'iterations'), { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'iterations', 'final-summary.md'),
        '# Summary\n\nAll done.',
        'utf-8'
      );

      const status = await reader.getTaskStatus('om_summary');

      expect(status).not.toBeNull();
      expect(status!.hasFinalSummary).toBe(true);
    });
  });

  describe('getActiveTasks', () => {
    it('should return empty summary when no tasks directory exists', async () => {
      const summary = await reader.getActiveTasks();

      expect(summary.tasks).toHaveLength(0);
      expect(summary.totalActive).toBe(0);
      expect(summary.generatedAt).toBeDefined();
    });

    it('should only return running tasks (no final_result.md)', async () => {
      // Create a running task
      const runningDir = path.join(tmpDir, 'tasks', 'om_running');
      await fs.mkdir(runningDir, { recursive: true });
      await fs.writeFile(
        path.join(runningDir, 'task.md'),
        `# Running Task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nRunning\n\`\`\`\n`,
        'utf-8'
      );

      // Create a completed task
      const completedDir = path.join(tmpDir, 'tasks', 'om_completed');
      await fs.mkdir(completedDir, { recursive: true });
      await fs.writeFile(
        path.join(completedDir, 'task.md'),
        `# Completed Task\n\n**Created**: 2026-03-29T09:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nDone\n\`\`\`\n`,
        'utf-8'
      );
      await fs.writeFile(
        path.join(completedDir, 'final_result.md'),
        'Done',
        'utf-8'
      );

      // Create a non-task directory (no task.md)
      await fs.mkdir(path.join(tmpDir, 'tasks', 'not_a_task'), { recursive: true });

      const summary = await reader.getActiveTasks();

      expect(summary.totalActive).toBe(1);
      expect(summary.tasks).toHaveLength(1);
      expect(summary.tasks[0].taskId).toBe('om_running');
      expect(summary.tasks[0].status).toBe('running');
    });

    it('should handle multiple active tasks', async () => {
      for (let i = 1; i <= 3; i++) {
        const taskDir = path.join(tmpDir, 'tasks', `om_task${i}`);
        await fs.mkdir(taskDir, { recursive: true });
        await fs.writeFile(
          path.join(taskDir, 'task.md'),
          `# Task ${i}\n\n**Created**: 2026-03-29T10:0${i}:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTask ${i}\n\`\`\`\n`,
          'utf-8'
        );
      }

      const summary = await reader.getActiveTasks();

      expect(summary.totalActive).toBe(3);
      expect(summary.tasks).toHaveLength(3);
    });
  });

  describe('getActiveTasksMarkdown', () => {
    it('should return no active tasks message when empty', async () => {
      const md = await reader.getActiveTasksMarkdown();
      expect(md).toContain('No active tasks found');
    });

    it('should return formatted markdown for active tasks', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_markdown');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Markdown Test Task\n\n**Task ID**: om_markdown\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat123\n\n## Original Request\n\n\`\`\`\nFix the authentication bug in login service\n\`\`\`\n`,
        'utf-8'
      );

      const md = await reader.getActiveTasksMarkdown();

      expect(md).toContain('Active Tasks (1)');
      expect(md).toContain('Markdown Test Task');
      expect(md).toContain('oc_chat123');
      expect(md).toContain('2026-03-29T10:00:00Z');
    });
  });

  describe('getTaskLatestIterationDetail', () => {
    it('should return null for non-existent task', async () => {
      const detail = await reader.getTaskLatestIterationDetail('non-existent');
      expect(detail).toBeNull();
    });

    it('should return null for task with no iterations', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_no_iter');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# No iter task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );

      const detail = await reader.getTaskLatestIterationDetail('om_no_iter');
      expect(detail).toBeNull();
    });

    it('should return evaluation and execution content', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_detail');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Detail task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );

      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });
      await fs.writeFile(
        path.join(iterDir, 'evaluation.md'),
        '## Evaluation\n\nTask is 50% complete.',
        'utf-8'
      );
      await fs.writeFile(
        path.join(iterDir, 'execution.md'),
        '## Execution\n\nModified auth.service.ts.',
        'utf-8'
      );

      const detail = await reader.getTaskLatestIterationDetail('om_detail');

      expect(detail).not.toBeNull();
      expect(detail).toContain('Latest Evaluation');
      expect(detail).toContain('Task is 50% complete');
      expect(detail).toContain('Latest Execution');
      expect(detail).toContain('Modified auth.service.ts');
    });

    it('should return only evaluation when execution is missing', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_eval_only');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Eval only\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );

      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });
      await fs.writeFile(
        path.join(iterDir, 'evaluation.md'),
        'Needs more work.',
        'utf-8'
      );

      const detail = await reader.getTaskLatestIterationDetail('om_eval_only');

      expect(detail).not.toBeNull();
      expect(detail).toContain('Latest Evaluation');
      expect(detail).toContain('Needs more work');
      expect(detail).not.toContain('Latest Execution');
    });
  });

  describe('edge cases', () => {
    it('should handle task.md with missing fields gracefully', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_minimal');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        'Just some text without proper structure',
        'utf-8'
      );

      const status = await reader.getTaskStatus('om_minimal');

      expect(status).not.toBeNull();
      expect(status!.status).toBe('running');
      expect(status!.title).toBe('Unknown Task');
      expect(status!.chatId).toBe('');
      expect(status!.createdAt).toBe('');
    });

    it('should handle empty task directory (no task.md)', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_empty');
      await fs.mkdir(taskDir, { recursive: true });

      const status = await reader.getTaskStatus('om_empty');

      // task.md doesn't exist, so status should be 'unknown'
      expect(status).not.toBeNull();
      expect(status!.status).toBe('unknown');
    });

    it('should skip non-iter directories when counting iterations', async () => {
      const taskDir = path.join(tmpDir, 'tasks', 'om_mixed');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Mixed task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\nTest\n\`\`\`\n`,
        'utf-8'
      );

      // Create valid and invalid iteration directories
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-1'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'steps'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-2'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'backup'), { recursive: true });

      const status = await reader.getTaskStatus('om_mixed');

      expect(status).not.toBeNull();
      expect(status!.totalIterations).toBe(2);
      expect(status!.latestIteration).toBe(2);
    });

    it('should handle long description truncation in markdown output', async () => {
      const longDesc = 'A'.repeat(300);
      const taskDir = path.join(tmpDir, 'tasks', 'om_long');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, 'task.md'),
        `# Long desc task\n\n**Created**: 2026-03-29T10:00:00Z\n**Chat ID**: oc_chat\n\n## Original Request\n\n\`\`\`\n${longDesc}\n\`\`\`\n`,
        'utf-8'
      );

      const md = await reader.getActiveTasksMarkdown();

      // Description should be truncated in markdown output
      expect(md).toContain('...');
      // But the full description should be available in TaskStatus
      const status = await reader.getTaskStatus('om_long');
      expect(status!.description.length).toBe(300);
    });
  });
});
