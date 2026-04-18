/**
 * Tests for get_task_status tool (packages/mcp-server/src/tools/task-status.ts)
 *
 * Issue #857: Task status reading for independent progress reporting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock credentials
vi.mock('./credentials.js', () => ({
  getWorkspaceDir: vi.fn(),
}));

import { get_task_status } from './task-status.js';
import { getWorkspaceDir } from './credentials.js';

describe('get_task_status', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-status-test-'));
    vi.mocked(getWorkspaceDir).mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should return error when taskId is empty', async () => {
      const result = await get_task_status({ taskId: '' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid taskId');
    });

    it('should return error when taskId is not a string', async () => {
      const result = await get_task_status({ taskId: null as any });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid taskId');
    });
  });

  describe('task not found', () => {
    it('should return exists=false when task directory does not exist', async () => {
      const result = await get_task_status({ taskId: 'nonexistent_task' });
      expect(result.success).toBe(true);
      expect(result.status?.exists).toBe(false);
      expect(result.status?.taskId).toBe('nonexistent_task');
    });
  });

  describe('task with only task.md (pending)', () => {
    it('should return phase=pending for a newly created task', async () => {
      const taskId = 'msg_001';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const taskMd = `# Task: Fix login bug

**Task ID**: msg_001
**Created**: 2026-04-18T00:00:00.000Z
**Chat ID**: oc_test123

## Original Request

\`\`\`
Fix the login bug in auth.ts
\`\`\`
`;
      await fs.writeFile(path.join(taskDir, 'task.md'), taskMd, 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.exists).toBe(true);
      expect(result.status?.title).toBe('Task: Fix login bug');
      expect(result.status?.phase).toBe('pending');
      expect(result.status?.totalIterations).toBe(0);
      expect(result.status?.hasFinalResult).toBe(false);
      expect(result.status?.iterations).toEqual([]);
    });
  });

  describe('task with iterations', () => {
    it('should report evaluating phase when evaluation exists but no execution', async () => {
      const taskId = 'msg_002';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test task', 'utf-8');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), '# Evaluation', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.phase).toBe('executing');
      expect(result.status?.totalIterations).toBe(1);
      expect(result.status?.iterations).toHaveLength(1);
      expect(result.status?.iterations[0].hasEvaluation).toBe(true);
      expect(result.status?.iterations[0].hasExecution).toBe(false);
    });

    it('should report evaluating phase when both eval and exec exist', async () => {
      const taskId = 'msg_003';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test', 'utf-8');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), '# Eval', 'utf-8');
      await fs.writeFile(path.join(iterDir, 'execution.md'), '# Exec', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.phase).toBe('evaluating');
    });

    it('should count steps correctly', async () => {
      const taskId = 'msg_004';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      const stepsDir = path.join(iterDir, 'steps');
      await fs.mkdir(stepsDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Steps', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'step-1.md'), 'Step 1', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'step-2.md'), 'Step 2', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'step-3.md'), 'Step 3', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.iterations[0].stepCount).toBe(3);
    });

    it('should handle multiple iterations', async () => {
      const taskId = 'msg_005';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iter1Dir = path.join(taskDir, 'iterations', 'iter-1');
      const iter2Dir = path.join(taskDir, 'iterations', 'iter-2');
      await fs.mkdir(iter1Dir, { recursive: true });
      await fs.mkdir(iter2Dir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Multi iter', 'utf-8');
      await fs.writeFile(path.join(iter1Dir, 'evaluation.md'), 'Eval 1', 'utf-8');
      await fs.writeFile(path.join(iter1Dir, 'execution.md'), 'Exec 1', 'utf-8');
      await fs.writeFile(path.join(iter2Dir, 'evaluation.md'), 'Eval 2', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.totalIterations).toBe(2);
      expect(result.status?.iterations[0].iteration).toBe(1);
      expect(result.status?.iterations[1].iteration).toBe(2);
      expect(result.status?.iterations[0].hasExecution).toBe(true);
      expect(result.status?.iterations[1].hasExecution).toBe(false);
    });
  });

  describe('completed task', () => {
    it('should return phase=completed when final_result.md exists', async () => {
      const taskId = 'msg_006';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterDir = path.join(taskDir, 'iterations', 'iter-1');
      await fs.mkdir(iterDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Done task', 'utf-8');
      await fs.writeFile(path.join(iterDir, 'evaluation.md'), 'Eval', 'utf-8');
      await fs.writeFile(path.join(iterDir, 'execution.md'), 'Exec', 'utf-8');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), '# Result', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.phase).toBe('completed');
      expect(result.status?.hasFinalResult).toBe(true);
    });

    it('should detect final-summary.md', async () => {
      const taskId = 'msg_007';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      const iterationsDir = path.join(taskDir, 'iterations');
      await fs.mkdir(iterationsDir, { recursive: true });

      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Summary', 'utf-8');
      await fs.writeFile(path.join(iterationsDir, 'final-summary.md'), '# Summary', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.hasFinalSummary).toBe(true);
    });
  });

  describe('task spec content', () => {
    it('should truncate long task spec to 2000 chars', async () => {
      const taskId = 'msg_008';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const longContent = `# Task: Long task\n\n${'x'.repeat(3000)}`;
      await fs.writeFile(path.join(taskDir, 'task.md'), longContent, 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.taskSpec).toBeTruthy();
      expect(result.status!.taskSpec!.length).toBeLessThanOrEqual(2010); // 2000 + '...' (3 chars) + margin
      expect(result.status!.taskSpec).toContain('...');
    });

    it('should include elapsed time', async () => {
      const taskId = 'msg_009';
      const taskDir = path.join(tempDir, 'tasks', taskId);
      await fs.mkdir(taskDir, { recursive: true });

      // Create task.md with a past mtime
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Timing', 'utf-8');

      const result = await get_task_status({ taskId });
      expect(result.success).toBe(true);
      expect(result.status?.elapsed).toBeTruthy();
      expect(result.status?.createdAt).toBeTruthy();
    });
  });

  describe('special characters in taskId', () => {
    it('should sanitize taskId with special characters', async () => {
      const taskId = 'oc_test/../../../etc/passwd';
      const result = await get_task_status({ taskId });
      // Should not throw, should just return not found
      expect(result.success).toBe(true);
      expect(result.status?.exists).toBe(false);
    });
  });
});
