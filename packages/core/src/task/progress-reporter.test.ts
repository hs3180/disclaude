/**
 * Tests for ProgressReporter.
 *
 * Verifies task progress scanning, card formatting, and report throttling.
 *
 * Issue #857: Task progress reporting mechanism.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProgressReporter, type TaskProgress } from './progress-reporter.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-reporter-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ProgressReporter', () => {
  let reporter: ProgressReporter;
  let tasksDir: string;

  beforeEach(() => {
    reporter = new ProgressReporter({ workspaceDir: tempDir, minReportIntervalMs: 1000 });
    tasksDir = path.join(tempDir, 'tasks');
  });

  async function createTaskDir(taskId: string): Promise<string> {
    const dir = path.join(tasksDir, taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeRunningLock(taskDir: string): Promise<void> {
    await fs.writeFile(path.join(taskDir, 'running.lock'), '', 'utf-8');
  }

  async function writeTaskMd(taskDir: string, content: string): Promise<void> {
    await fs.writeFile(path.join(taskDir, 'task.md'), content, 'utf-8');
  }

  async function createIteration(taskDir: string, iteration: number): Promise<string> {
    const iterDir = path.join(taskDir, 'iterations', `iter-${iteration}`);
    await fs.mkdir(iterDir, { recursive: true });
    return iterDir;
  }

  describe('getRunningTasks', () => {
    it('should return empty array when no tasks exist', async () => {
      const result = await reporter.getRunningTasks();
      expect(result).toEqual([]);
    });

    it('should skip tasks without running.lock', async () => {
      const dir = await createTaskDir('task-1');
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');

      const result = await reporter.getRunningTasks();
      expect(result).toEqual([]);
    });

    it('should skip completed tasks (with final_result.md)', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');
      await fs.writeFile(path.join(dir, 'final_result.md'), 'done', 'utf-8');

      const result = await reporter.getRunningTasks();
      expect(result).toEqual([]);
    });

    it('should skip failed tasks (with failed.md)', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');
      await fs.writeFile(path.join(dir, 'failed.md'), 'error', 'utf-8');

      const result = await reporter.getRunningTasks();
      expect(result).toEqual([]);
    });

    it('should find running tasks', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Fix Bug\n\n**Chat ID**: oc_abc123');

      const result = await reporter.getRunningTasks();
      expect(result).toHaveLength(1);
      expect(result[0]!.taskId).toBe('task-1');
      expect(result[0]!.title).toBe('Fix Bug');
      expect(result[0]!.chatId).toBe('oc_abc123');
    });

    it('should find multiple running tasks', async () => {
      for (const id of ['task-1', 'task-2', 'task-3']) {
        const dir = await createTaskDir(id);
        await writeRunningLock(dir);
        await writeTaskMd(dir, `# Task: ${id}\n\n**Chat ID**: oc_chat_${id}`);
      }

      const result = await reporter.getRunningTasks();
      expect(result).toHaveLength(3);
    });

    it('should read iteration info correctly', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');

      // Create 2 iterations
      const iter1 = await createIteration(dir, 1);
      await fs.writeFile(path.join(iter1, 'execution.md'), '## Summary\nExecuted step 1', 'utf-8');
      await fs.writeFile(path.join(iter1, 'evaluation.md'), '## Status\nNEED_EXECUTE', 'utf-8');

      const iter2 = await createIteration(dir, 2);
      await fs.writeFile(path.join(iter2, 'execution.md'), '## Summary\nExecuted step 2', 'utf-8');
      await fs.writeFile(path.join(iter2, 'evaluation.md'), '## Status\nNEED_EXECUTE', 'utf-8');

      const result = await reporter.getRunningTasks();
      expect(result).toHaveLength(1);
      expect(result[0]!.totalIterations).toBe(2);
      expect(result[0]!.currentIteration).toBe(2);
      expect(result[0]!.latestEvaluationStatus).toBe('NEED_EXECUTE');
      expect(result[0]!.latestExecutionSummary).toContain('Executed step 2');
    });

    it('should default to empty string for chatId when not found', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: No Chat\n\nSome content');

      const result = await reporter.getRunningTasks();
      expect(result).toHaveLength(1);
      expect(result[0]!.chatId).toBe('');
    });
  });

  describe('report throttling', () => {
    it('should report when no previous report exists', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');

      const result = await reporter.getRunningTasks();
      expect(result[0]!.shouldReport).toBe(true);
    });

    it('should not report if last report is too recent', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');
      // Write a recent marker
      await fs.writeFile(
        path.join(dir, '.last-progress-report'),
        new Date().toISOString(),
        'utf-8',
      );

      const result = await reporter.getRunningTasks();
      expect(result[0]!.shouldReport).toBe(false);
    });

    it('should report if last report is old enough', async () => {
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');
      // Write an old marker (2 seconds ago, minReportInterval is 1000ms)
      const oldTime = new Date(Date.now() - 2000).toISOString();
      await fs.writeFile(path.join(dir, '.last-progress-report'), oldTime, 'utf-8');

      const result = await reporter.getRunningTasks();
      expect(result[0]!.shouldReport).toBe(true);
    });

    it('should respect custom minReportIntervalMs', async () => {
      const fastReporter = new ProgressReporter({ workspaceDir: tempDir, minReportIntervalMs: 0 });
      const dir = await createTaskDir('task-1');
      await writeRunningLock(dir);
      await writeTaskMd(dir, '# Task: Test\n\n**Chat ID**: oc_123');
      // Even a very recent marker should be old enough with 0ms interval
      await fs.writeFile(
        path.join(dir, '.last-progress-report'),
        new Date().toISOString(),
        'utf-8',
      );

      const result = await fastReporter.getRunningTasks();
      expect(result[0]!.shouldReport).toBe(true);
    });
  });

  describe('markReportSent', () => {
    it('should write marker file', async () => {
      const dir = await createTaskDir('task-1');
      await reporter.markReportSent('task-1');

      const content = await fs.readFile(path.join(dir, '.last-progress-report'), 'utf-8');
      expect(content).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(() => new Date(content)).not.toThrow();
    });

    it('should update existing marker file', async () => {
      const dir = await createTaskDir('task-1');
      await fs.writeFile(path.join(dir, '.last-progress-report'), '2020-01-01T00:00:00.000Z', 'utf-8');

      await reporter.markReportSent('task-1');

      const content = await fs.readFile(path.join(dir, '.last-progress-report'), 'utf-8');
      expect(content).not.toBe('2020-01-01T00:00:00.000Z');
    });
  });

  describe('getLastReportTime', () => {
    it('should return null when no marker exists', async () => {
      await createTaskDir('task-1');
      const result = await reporter.getLastReportTime('task-1');
      expect(result).toBeNull();
    });

    it('should return timestamp from marker file', async () => {
      const dir = await createTaskDir('task-1');
      const timestamp = '2026-04-22T10:00:00.000Z';
      await fs.writeFile(path.join(dir, '.last-progress-report'), timestamp, 'utf-8');

      const result = await reporter.getLastReportTime('task-1');
      expect(result).toBe(timestamp);
    });
  });

  describe('buildProgressCard', () => {
    it('should build a valid Feishu card with task info', () => {
      const progress: TaskProgress = {
        taskId: 'test-1',
        taskDir: '/tmp/test',
        title: 'Fix authentication bug',
        chatId: 'oc_123',
        currentIteration: 2,
        totalIterations: 2,
        latestExecutionSummary: 'Fixed auth.ts and updated tests',
        latestEvaluationStatus: 'NEED_EXECUTE',
        startedAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
        lastActivityAt: new Date().toISOString(),
        lastReportAt: null,
        shouldReport: true,
      };

      const card = reporter.buildProgressCard(progress);

      expect(card.header).toBeDefined();
      expect(card.elements).toBeDefined();
      expect(card.elements!.length).toBeGreaterThan(0);

      // Check card structure
      const elements = card.elements!;
      const mdContents = elements
        .filter(e => e.tag === 'markdown')
        .map(e => e.content as string);

      expect(mdContents.some(c => c.includes('Fix authentication bug'))).toBe(true);
      expect(mdContents.some(c => c.includes('NEED_EXECUTE'))).toBe(true);
      expect(mdContents.some(c => c.includes('第 2 轮'))).toBe(true);
    });

    it('should include execution summary when present', () => {
      const progress: TaskProgress = {
        taskId: 'test-1',
        taskDir: '/tmp/test',
        title: 'Test',
        chatId: 'oc_123',
        currentIteration: 1,
        totalIterations: 1,
        latestExecutionSummary: 'Modified 3 files',
        latestEvaluationStatus: '',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastReportAt: null,
        shouldReport: true,
      };

      const card = reporter.buildProgressCard(progress);
      const mdContents = card.elements!
        .filter(e => e.tag === 'markdown')
        .map(e => e.content as string);

      expect(mdContents.some(c => c.includes('Modified 3 files'))).toBe(true);
    });

    it('should truncate long execution summaries', () => {
      const longSummary = 'A'.repeat(500);
      const progress: TaskProgress = {
        taskId: 'test-1',
        taskDir: '/tmp/test',
        title: 'Test',
        chatId: 'oc_123',
        currentIteration: 1,
        totalIterations: 1,
        latestExecutionSummary: longSummary,
        latestEvaluationStatus: '',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastReportAt: null,
        shouldReport: true,
      };

      const card = reporter.buildProgressCard(progress);
      const mdContents = card.elements!
        .filter(e => e.tag === 'markdown')
        .map(e => e.content as string);

      // Should be truncated to ~300 chars + '...'
      const summaryElement = mdContents.find(c => c.includes('最近执行'));
      expect(summaryElement).toBeDefined();
      expect(summaryElement!.length).toBeLessThan(400);
      expect(summaryElement!.includes('...')).toBe(true);
    });

    it('should not include execution section when summary is empty', () => {
      const progress: TaskProgress = {
        taskId: 'test-1',
        taskDir: '/tmp/test',
        title: 'Test',
        chatId: 'oc_123',
        currentIteration: 0,
        totalIterations: 0,
        latestExecutionSummary: '',
        latestEvaluationStatus: '',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastReportAt: null,
        shouldReport: true,
      };

      const card = reporter.buildProgressCard(progress);
      const mdContents = card.elements!
        .filter(e => e.tag === 'markdown')
        .map(e => e.content as string);

      expect(mdContents.some(c => c.includes('最近执行'))).toBe(false);
    });

    it('should use correct status icons', () => {
      const makeProgress = (status: string): TaskProgress => ({
        taskId: 'test',
        taskDir: '/tmp',
        title: 'T',
        chatId: 'oc_',
        currentIteration: 1,
        totalIterations: 1,
        latestExecutionSummary: '',
        latestEvaluationStatus: status,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastReportAt: null,
        shouldReport: true,
      });

      const completeCard = reporter.buildProgressCard(makeProgress('COMPLETE'));
      const completeContents = completeCard.elements!.map(e => (e as {content?: string}).content ?? '').join('');
      expect(completeContents.includes('✅')).toBe(true);

      const needExecCard = reporter.buildProgressCard(makeProgress('NEED_EXECUTE'));
      const needExecContents = needExecCard.elements!.map(e => (e as {content?: string}).content ?? '').join('');
      expect(needExecContents.includes('🔄')).toBe(true);

      const unknownCard = reporter.buildProgressCard(makeProgress(''));
      const unknownContents = unknownCard.elements!.map(e => (e as {content?: string}).content ?? '').join('');
      expect(unknownContents.includes('⏳')).toBe(true);
    });
  });
});
