/**
 * Tests for get_task_status tool (packages/mcp-server/src/tools/get-task-status.ts)
 * Issue #857: Task status and progress reporting tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock the credentials module before importing
vi.mock('./credentials.js', () => ({
  getWorkspaceDir: () => '/tmp/test-workspace',
}));

// Mock the logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Import after mocks are set up
import { get_task_status, list_tasks, update_task_progress } from './get-task-status.js';

describe('get_task_status', () => {
  const taskDir = '/tmp/test-workspace/tasks/test_task_123';

  beforeEach(async () => {
    // Create task directory structure
    await fs.mkdir(taskDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    await fs.rm('/tmp/test-workspace', { recursive: true, force: true });
  });

  describe('task not found', () => {
    it('should return error when taskId is empty', async () => {
      const result = await get_task_status({ taskId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should return error when task directory does not exist', async () => {
      const result = await get_task_status({ taskId: 'nonexistent' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('pending task', () => {
    it('should return pending status for task with only task.md', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), `---
createdAt: 2026-03-23T10:00:00Z
maxIterations: 5
---

# Task: Fix auth bug

## Description
Fix the authentication bug.
`, 'utf-8');

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.status).toBe('pending');
      expect(result.data!.title).toBe('Task: Fix auth bug');
      expect(result.data!.iterations).toBe(0);
      expect(result.data!.maxIterations).toBe(5);
      expect(result.data!.hasFinalResult).toBe(false);
      expect(result.data!.isRunning).toBe(false);
      expect(result.data!.isFailed).toBe(false);
    });
  });

  describe('running task', () => {
    it('should return running status when running.lock exists', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n', 'utf-8');
      await fs.writeFile(path.join(taskDir, 'running.lock'), '', 'utf-8');

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('running');
      expect(result.data!.isRunning).toBe(true);
    });
  });

  describe('completed task', () => {
    it('should return completed status when final_result.md exists', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n', 'utf-8');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), '# Final Result\n', 'utf-8');

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('completed');
      expect(result.data!.hasFinalResult).toBe(true);
    });
  });

  describe('failed task', () => {
    it('should return failed status when failed.md exists', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n', 'utf-8');
      await fs.writeFile(path.join(taskDir, 'failed.md'), '# Failed\nBuild failed with errors.\n', 'utf-8');

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('failed');
      expect(result.data!.isFailed).toBe(true);
      expect(result.data!.errorMessage).toContain('Build failed');
    });
  });

  describe('iterations counting', () => {
    it('should count iteration directories', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n', 'utf-8');
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-1'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-2'), { recursive: true });
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-3'), { recursive: true });
      // Create a non-iteration directory that should be ignored
      await fs.mkdir(path.join(taskDir, 'iterations', 'notes'), { recursive: true });

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data!.iterations).toBe(3);
    });
  });

  describe('progress reading', () => {
    it('should read progress from progress.md', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n', 'utf-8');
      await fs.writeFile(path.join(taskDir, 'progress.md'), `# Progress Update

**Updated**: 2026-03-23T10:30:00Z

## Summary

Modified auth.service.ts to add JWT validation.
Running tests...
`, 'utf-8');

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data!.progressSummary).toContain('Modified auth.service.ts');
      expect(result.data!.lastProgressUpdate).toBeDefined();
    });

    it('should fallback to execution.md when progress.md is missing', async () => {
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\n', 'utf-8');
      await fs.mkdir(path.join(taskDir, 'iterations', 'iter-1'), { recursive: true });
      await fs.writeFile(path.join(taskDir, 'iterations', 'iter-1', 'execution.md'), `# Execution: Iteration 1

**Timestamp**: 2026-03-23T10:00:00Z

## Summary

Fixed the authentication bug in login handler.
`, 'utf-8');

      const result = await get_task_status({ taskId: 'test_task_123' });
      expect(result.success).toBe(true);
      expect(result.data!.progressSummary).toContain('Fixed the authentication bug');
    });
  });

  describe('taskId sanitization', () => {
    it('should sanitize taskId with special characters', async () => {
      // Create directory with sanitized name
      const sanitizedDir = '/tmp/test-workspace/tasks/om_abc_123_def';
      await fs.mkdir(sanitizedDir, { recursive: true });
      await fs.writeFile(path.join(sanitizedDir, 'task.md'), '# Task: Sanitized\n', 'utf-8');

      const result = await get_task_status({ taskId: 'om_abc@123#def' });
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('pending');
    });
  });
});

describe('list_tasks', () => {
  const tasksDir = '/tmp/test-workspace/tasks';

  beforeEach(async () => {
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm('/tmp/test-workspace', { recursive: true, force: true });
  });

  it('should return empty array when no tasks exist', async () => {
    const result = await list_tasks();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('should return empty array when tasks directory does not exist', async () => {
    await fs.rm(tasksDir, { recursive: true, force: true });
    const result = await list_tasks();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('should list all tasks sorted by status priority', async () => {
    // Create tasks with different statuses
    const runningDir = path.join(tasksDir, 'running_task');
    const pendingDir = path.join(tasksDir, 'pending_task');
    const completedDir = path.join(tasksDir, 'completed_task');

    await fs.mkdir(runningDir, { recursive: true });
    await fs.writeFile(path.join(runningDir, 'task.md'), '# Running Task\n', 'utf-8');
    await fs.writeFile(path.join(runningDir, 'running.lock'), '', 'utf-8');

    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, 'task.md'), '# Pending Task\n', 'utf-8');

    await fs.mkdir(completedDir, { recursive: true });
    await fs.writeFile(path.join(completedDir, 'task.md'), '# Completed Task\n', 'utf-8');
    await fs.writeFile(path.join(completedDir, 'final_result.md'), '# Done\n', 'utf-8');

    const result = await list_tasks();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
    // Should be sorted: running, pending, completed
    expect(result.data![0].status).toBe('running');
    expect(result.data![1].status).toBe('pending');
    expect(result.data![2].status).toBe('completed');
  });
});

describe('update_task_progress', () => {
  const taskDir = '/tmp/test-workspace/tasks/test_task_123';

  beforeEach(async () => {
    await fs.mkdir(taskDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm('/tmp/test-workspace', { recursive: true, force: true });
  });

  it('should return error when taskId is empty', async () => {
    const result = await update_task_progress({ taskId: '', summary: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should return error when summary is empty', async () => {
    const result = await update_task_progress({ taskId: 'test', summary: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should create progress.md with summary only', async () => {
    const result = await update_task_progress({
      taskId: 'test_task_123',
      summary: 'Modified auth.service.ts',
    });
    expect(result.success).toBe(true);

    const content = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf-8');
    expect(content).toContain('Modified auth.service.ts');
    expect(content).toContain('# Progress Update');
    expect(content).not.toContain('## Progress');
  });

  it('should create progress.md with step numbers', async () => {
    const result = await update_task_progress({
      taskId: 'test_task_123',
      summary: 'Working on auth module',
      currentStep: 3,
      totalSteps: 8,
      nextStep: 'Run unit tests',
    });
    expect(result.success).toBe(true);

    const content = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf-8');
    expect(content).toContain('Working on auth module');
    expect(content).toContain('3 / 8');
    expect(content).toContain('Run unit tests');
    expect(content).toContain('## Progress');
    expect(content).toContain('## Next Step');
  });

  it('should overwrite existing progress.md', async () => {
    await fs.writeFile(path.join(taskDir, 'progress.md'), '# Old Progress\nOld content', 'utf-8');

    await update_task_progress({
      taskId: 'test_task_123',
      summary: 'New progress update',
    });

    const content = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf-8');
    expect(content).toContain('New progress update');
    expect(content).not.toContain('Old content');
  });

  it('should create task directory if it does not exist', async () => {
    await fs.rm(taskDir, { recursive: true, force: true });

    const result = await update_task_progress({
      taskId: 'test_task_123',
      summary: 'First progress update',
    });
    expect(result.success).toBe(true);

    const content = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf-8');
    expect(content).toContain('First progress update');
  });
});
