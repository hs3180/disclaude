/**
 * Tests for TaskContextReader.
 *
 * Verifies task state reading and context snapshot generation.
 *
 * @see Issue #857 - Task progress reporting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskContextReader } from './task-context-reader.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-reader-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Helper to create a standard task directory structure with task.md.
 */
async function createTask(taskId: string, overrides?: { title?: string; chatId?: string; createdAt?: string }) {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const taskDir = path.join(tempDir, 'tasks', sanitized);
  await fs.mkdir(taskDir, { recursive: true });

  const title = overrides?.title ?? 'Build a REST API';
  const chatId = overrides?.chatId ?? 'oc_test123';
  const createdAt = overrides?.createdAt ?? '2026-04-20T09:00:00Z';

  const taskMd = `# Task: ${title}

**Task ID**: ${taskId}
**Created**: ${createdAt}
**Chat ID**: ${chatId}
**User ID**: user_abc

## Original Request

\`\`\`
Create a REST API with user authentication
\`\`\`

## Task Objectives

### Primary Goal
Build a fully functional REST API with user authentication and CRUD operations.

### Success Criteria
- API returns correct status codes
- Authentication works correctly
- Tests pass

### Expected Outcome
A working REST API with tests and documentation.

## Delivery Specifications

### Required Deliverables
- API code
- Tests
- Documentation
`;

  await fs.writeFile(path.join(taskDir, 'task.md'), taskMd, 'utf-8');
  return taskDir;
}

/**
 * Helper to create an iteration with evaluation and execution files.
 */
async function createIteration(taskDir: string, iteration: number, opts?: {
  evalStatus?: string;
  evalSummary?: string;
  execSummary?: string;
}) {
  const iterDir = path.join(taskDir, 'iterations', `iter-${iteration}`);
  await fs.mkdir(iterDir, { recursive: true });

  const evalStatus = opts?.evalStatus ?? 'NEED_EXECUTE';
  const evalSummary = opts?.evalSummary ?? 'First iteration, need to start.';
  const execSummary = opts?.execSummary ?? 'Created basic API structure.';

  const evaluationMd = `# Evaluation: Iteration ${iteration}

## Status
${evalStatus}

## Assessment
${evalSummary}

## Next Actions
- Continue implementation
`;

  await fs.writeFile(path.join(iterDir, 'evaluation.md'), evaluationMd, 'utf-8');

  if (opts?.execSummary !== undefined || execSummary) {
    const executionMd = `# Execution: Iteration ${iteration}

**Timestamp**: 2026-04-20T09:05:00Z
**Status**: Completed

## Summary
${execSummary}

## Changes Made
- Created API server
- Added authentication middleware

## Files Modified
- src/server.ts
- src/auth.ts
`;

    await fs.writeFile(path.join(iterDir, 'execution.md'), executionMd, 'utf-8');
  }

  return iterDir;
}

describe('TaskContextReader', () => {
  let reader: TaskContextReader;

  beforeEach(() => {
    reader = new TaskContextReader(tempDir);
  });

  describe('readTaskContext', () => {
    it('should return null for non-existent task', async () => {
      const result = await reader.readTaskContext('non-existent');
      expect(result).toBeNull();
    });

    it('should read basic task context from task.md', async () => {
      await createTask('msg-001');

      const context = await reader.readTaskContext('msg-001');
      expect(context).not.toBeNull();

      expect(context!.taskId).toBe('msg-001');
      expect(context!.title).toBe('Build a REST API');
      expect(context!.chatId).toBe('oc_test123');
      expect(context!.createdAt).toBe('2026-04-20T09:00:00Z');
      expect(context!.originalRequest).toContain('Create a REST API');
      expect(context!.status).toBe('in_progress');
      expect(context!.totalIterations).toBe(0);
      expect(context!.iterations).toEqual([]);
      expect(context!.hasFinalResult).toBe(false);
      expect(context!.primaryGoal).toContain('REST API');
    });

    it('should extract deliverables from task.md', async () => {
      await createTask('msg-002');

      const context = await reader.readTaskContext('msg-002');
      expect(context!.deliverables).toContain('API code');
      expect(context!.deliverables).toContain('Tests');
      expect(context!.deliverables).toContain('Documentation');
    });

    it('should count success criteria', async () => {
      await createTask('msg-003');

      const context = await reader.readTaskContext('msg-003');
      expect(context!.successCriteriaCount).toBe(3);
    });

    it('should sanitize task ID for path lookup', async () => {
      await createTask('msg/test@123');

      const context = await reader.readTaskContext('msg/test@123');
      expect(context).not.toBeNull();
      expect(context!.taskId).toBe('msg/test@123');
      expect(context!.title).toBe('Build a REST API');
    });
  });

  describe('iterations', () => {
    it('should read iteration data', async () => {
      const taskDir = await createTask('msg-010');
      await createIteration(taskDir, 1);

      const context = await reader.readTaskContext('msg-010');
      expect(context!.totalIterations).toBe(1);

      const [iter] = context!.iterations;
      expect(iter.number).toBe(1);
      expect(iter.status).toBe('completed');
      expect(iter.evaluationVerdict).toBe('NEED_EXECUTE');
      expect(iter.evaluationSummary).toContain('First iteration');
      expect(iter.executionSummary).toContain('basic API structure');
    });

    it('should read multiple iterations in order', async () => {
      const taskDir = await createTask('msg-011');
      await createIteration(taskDir, 1);
      await createIteration(taskDir, 2, { evalStatus: 'COMPLETE', evalSummary: 'All done.' });

      const context = await reader.readTaskContext('msg-011');
      expect(context!.totalIterations).toBe(2);
      expect(context!.iterations[0].number).toBe(1);
      expect(context!.iterations[1].number).toBe(2);
      expect(context!.iterations[1].evaluationVerdict).toBe('COMPLETE');
    });

    it('should handle iteration with only evaluation', async () => {
      const taskDir = await createTask('msg-012');
      const iterDir = await createIteration(taskDir, 1, { execSummary: undefined });
      // Remove execution.md that createIteration might have created
      try { await fs.unlink(path.join(iterDir, 'execution.md')); } catch { /* ignore */ }

      const context = await reader.readTaskContext('msg-012');
      expect(context!.iterations[0].status).toBe('evaluating');
      expect(context!.iterations[0].executionSummary).toBeNull();
    });

    it('should handle iteration with only execution', async () => {
      const taskDir = await createTask('msg-013');
      const iterDir = await createIteration(taskDir, 1);
      try { await fs.unlink(path.join(iterDir, 'evaluation.md')); } catch { /* ignore */ }

      const context = await reader.readTaskContext('msg-013');
      expect(context!.iterations[0].status).toBe('executing');
      expect(context!.iterations[0].evaluationSummary).toBeNull();
    });

    it('should count step files', async () => {
      const taskDir = await createTask('msg-014');
      const iterDir = await createIteration(taskDir, 1);
      const stepsDir = path.join(iterDir, 'steps');
      await fs.mkdir(stepsDir, { recursive: true });
      await fs.writeFile(path.join(stepsDir, 'step-1.md'), '# Step 1', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'step-2.md'), '# Step 2', 'utf-8');
      await fs.writeFile(path.join(stepsDir, 'not-a-step.txt'), '', 'utf-8');

      const context = await reader.readTaskContext('msg-014');
      expect(context!.iterations[0].stepCount).toBe(2);
    });

    it('should handle task with no iterations directory', async () => {
      await createTask('msg-015');

      const context = await reader.readTaskContext('msg-015');
      expect(context!.totalIterations).toBe(0);
    });
  });

  describe('task status', () => {
    it('should mark task as completed when final_result.md exists', async () => {
      const taskDir = await createTask('msg-020');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), '# Final Result\nDone.', 'utf-8');

      const context = await reader.readTaskContext('msg-020');
      expect(context!.status).toBe('completed');
      expect(context!.hasFinalResult).toBe(true);
    });

    it('should mark task as completed when final-summary.md exists', async () => {
      const taskDir = await createTask('msg-021');
      await fs.mkdir(path.join(taskDir, 'iterations'), { recursive: true });
      await fs.writeFile(path.join(taskDir, 'iterations', 'final-summary.md'), '# Summary\nDone.', 'utf-8');

      const context = await reader.readTaskContext('msg-021');
      expect(context!.status).toBe('completed');
      expect(context!.hasFinalSummary).toBe(true);
    });

    it('should mark task as in_progress when no final files exist', async () => {
      await createTask('msg-022');

      const context = await reader.readTaskContext('msg-022');
      expect(context!.status).toBe('in_progress');
    });
  });

  describe('elapsed time', () => {
    it('should calculate elapsed time from createdAt', async () => {
      // Use a time 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await createTask('msg-030', { createdAt: twoHoursAgo });

      const context = await reader.readTaskContext('msg-030');
      expect(context!.elapsed).not.toBeNull();
      expect(context!.elapsed).toContain('2h');
    });

    it('should return null for invalid createdAt', async () => {
      await createTask('msg-031', { createdAt: 'invalid-date' });

      const context = await reader.readTaskContext('msg-031');
      expect(context!.elapsed).toBeNull();
    });

    it('should return null when createdAt is missing', async () => {
      const sanitized = 'msg-032';
      const taskDir = path.join(tempDir, 'tasks', sanitized);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: Test\nNo created field.\n', 'utf-8');

      const context = await reader.readTaskContext('msg-032');
      expect(context!.elapsed).toBeNull();
    });
  });

  describe('readAllTaskContexts', () => {
    it('should return empty array when no tasks exist', async () => {
      const contexts = await reader.readAllTaskContexts();
      expect(contexts).toEqual([]);
    });

    it('should read all tasks in workspace', async () => {
      await createTask('msg-040');
      await createTask('msg-041', { title: 'Fix Bug' });

      const contexts = await reader.readAllTaskContexts();
      expect(contexts).toHaveLength(2);

      const titles = contexts.map(c => c.title).sort();
      expect(titles).toContain('Build a REST API');
      expect(titles).toContain('Fix Bug');
    });

    it('should return empty array when tasks directory does not exist', async () => {
      const reader2 = new TaskContextReader('/non/existent/path');
      const contexts = await reader2.readAllTaskContexts();
      expect(contexts).toEqual([]);
    });
  });

  describe('readTaskContextsByChat', () => {
    it('should filter tasks by chat ID', async () => {
      await createTask('msg-050', { chatId: 'oc_chat_a' });
      await createTask('msg-051', { chatId: 'oc_chat_b' });
      await createTask('msg-052', { chatId: 'oc_chat_a' });

      const chatAContexts = await reader.readTaskContextsByChat('oc_chat_a');
      expect(chatAContexts).toHaveLength(2);

      const chatBContexts = await reader.readTaskContextsByChat('oc_chat_b');
      expect(chatBContexts).toHaveLength(1);
    });
  });

  describe('isTaskInProgress', () => {
    it('should return true for in-progress task', async () => {
      await createTask('msg-060');

      expect(await reader.isTaskInProgress('msg-060')).toBe(true);
    });

    it('should return false for completed task', async () => {
      const taskDir = await createTask('msg-061');
      await fs.writeFile(path.join(taskDir, 'final_result.md'), 'Done', 'utf-8');

      expect(await reader.isTaskInProgress('msg-061')).toBe(false);
    });

    it('should return false for non-existent task', async () => {
      expect(await reader.isTaskInProgress('non-existent')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle task.md without Original Request section', async () => {
      const sanitized = 'msg-070';
      const taskDir = path.join(tempDir, 'tasks', sanitized);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: No Request\n**Created**: 2026-04-20T09:00:00Z\n', 'utf-8');

      const context = await reader.readTaskContext('msg-070');
      expect(context).not.toBeNull();
      expect(context!.originalRequest).toBe('');
    });

    it('should handle task.md without Task Objectives section', async () => {
      const sanitized = 'msg-071';
      const taskDir = path.join(tempDir, 'tasks', sanitized);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'), '# Task: No Objectives\n**Created**: 2026-04-20T09:00:00Z\n', 'utf-8');

      const context = await reader.readTaskContext('msg-071');
      expect(context!.primaryGoal).toBeNull();
      expect(context!.deliverables).toEqual([]);
      expect(context!.successCriteriaCount).toBe(0);
    });

    it('should truncate long summaries', async () => {
      const longGoal = 'A'.repeat(500);
      const sanitized = 'msg-072';
      const taskDir = path.join(tempDir, 'tasks', sanitized);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'task.md'),
        `# Task: Long\n**Created**: 2026-04-20T09:00:00Z\n\n## Task Objectives\n\n### Primary Goal\n${longGoal}\n`,
        'utf-8'
      );

      const context = await reader.readTaskContext('msg-072');
      expect(context!.primaryGoal!.length).toBeLessThanOrEqual(200);
    });

    it('should skip non-iteration directories', async () => {
      const taskDir = await createTask('msg-073');
      const iterationsDir = path.join(taskDir, 'iterations');
      await fs.mkdir(iterationsDir, { recursive: true });
      // Create a non-iteration directory
      await fs.mkdir(path.join(iterationsDir, 'not-an-iteration'), { recursive: true });
      await createIteration(taskDir, 1);

      const context = await reader.readTaskContext('msg-073');
      expect(context!.totalIterations).toBe(1);
      expect(context!.iterations[0].number).toBe(1);
    });
  });
});
