/**
 * Tests for TaskHistory module.
 *
 * @module task/task-history.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskHistory, type TaskHistoryEntry } from './task-history.js';

describe('TaskHistory', () => {
  let tmpDir: string;
  let history: TaskHistory;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-history-test-'));
    history = new TaskHistory({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const createEntry = (overrides?: Partial<TaskHistoryEntry>): TaskHistoryEntry => ({
    taskId: 'cli-001',
    title: 'Fix timeout issue',
    category: 'bug-fix',
    createdAt: '2026-05-01T10:00:00Z',
    completedAt: '2026-05-01T10:15:30Z',
    durationMs: 930000,
    iterations: 3,
    outcome: 'success',
    tags: ['test', 'integration'],
    ...overrides,
  });

  describe('recordTask', () => {
    it('records a task entry', async () => {
      await history.recordTask(createEntry());

      const result = await history.getTask('cli-001');
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('cli-001');
      expect(result!.title).toBe('Fix timeout issue');
      expect(result!.category).toBe('bug-fix');
      expect(result!.durationMs).toBe(930000);
    });

    it('updates existing entry with same taskId', async () => {
      await history.recordTask(createEntry());
      await history.recordTask(createEntry({ durationMs: 1200000, iterations: 5 }));

      const entries = await history.query();
      expect(entries).toHaveLength(1);
      expect(entries[0].durationMs).toBe(1200000);
    });

    it('persists to file', async () => {
      await history.recordTask(createEntry());

      // Create a new instance reading from the same file
      const history2 = new TaskHistory({ workspaceDir: tmpDir });
      const result = await history2.getTask('cli-001');
      expect(result).not.toBeNull();
    });

    it('trims to 500 entries max', async () => {
      for (let i = 0; i < 510; i++) {
        await history.recordTask(createEntry({
          taskId: `cli-${i.toString().padStart(3, '0')}`,
          title: `Task ${i}`,
        }));
      }

      const entries = await history.query();
      expect(entries).toHaveLength(500);
      // Should keep the most recent entries
      expect(entries.some(e => e.taskId === 'cli-510')).toBe(false);
      expect(entries.some(e => e.taskId === 'cli-509')).toBe(true);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await history.recordTask(createEntry({
        taskId: 'cli-001',
        category: 'bug-fix',
        outcome: 'success',
        completedAt: '2026-05-01T10:15:30Z',
        tags: ['test'],
      }));
      await history.recordTask(createEntry({
        taskId: 'cli-002',
        category: 'feature',
        outcome: 'success',
        completedAt: '2026-05-02T10:00:00Z',
        durationMs: 1800000,
        tags: ['feature'],
      }));
      await history.recordTask(createEntry({
        taskId: 'cli-003',
        category: 'bug-fix',
        outcome: 'failed',
        completedAt: '2026-05-03T10:00:00Z',
        durationMs: 600000,
        tags: [],
      }));
    });

    it('returns all entries sorted by completion time (newest first)', async () => {
      const entries = await history.query();
      expect(entries).toHaveLength(3);
      expect(entries[0].taskId).toBe('cli-003');
      expect(entries[1].taskId).toBe('cli-002');
      expect(entries[2].taskId).toBe('cli-001');
    });

    it('filters by category', async () => {
      const entries = await history.query({ category: 'bug-fix' });
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.category === 'bug-fix')).toBe(true);
    });

    it('filters by outcome', async () => {
      const entries = await history.query({ outcome: 'failed' });
      expect(entries).toHaveLength(1);
      expect(entries[0].taskId).toBe('cli-003');
    });

    it('filters by tags', async () => {
      const entries = await history.query({ tags: ['test'] });
      expect(entries).toHaveLength(1);
      expect(entries[0].taskId).toBe('cli-001');
    });

    it('filters by date', async () => {
      const entries = await history.query({ since: '2026-05-02T00:00:00Z' });
      expect(entries).toHaveLength(2);
    });

    it('applies limit', async () => {
      const entries = await history.query({ limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });

  describe('getStats', () => {
    it('returns null when no entries match', async () => {
      const stats = await history.getStats({ category: 'non-existent' });
      expect(stats).toBeNull();
    });

    it('computes statistics correctly', async () => {
      await history.recordTask(createEntry({ durationMs: 600000, outcome: 'success' }));
      await history.recordTask(createEntry({
        taskId: 'cli-002',
        durationMs: 1200000,
        outcome: 'success',
      }));
      await history.recordTask(createEntry({
        taskId: 'cli-003',
        durationMs: 900000,
        outcome: 'failed',
      }));

      const stats = await history.getStats();

      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(3);
      expect(stats!.averageDurationMs).toBe(900000);
      expect(stats!.medianDurationMs).toBe(900000);
      expect(stats!.minDurationMs).toBe(600000);
      expect(stats!.maxDurationMs).toBe(1200000);
      expect(stats!.successRate).toBeCloseTo(2 / 3);
    });
  });

  describe('getFormattedSummary', () => {
    it('returns message when no history', async () => {
      const summary = await history.getFormattedSummary();
      expect(summary).toBe('No task history available.');
    });

    it('includes statistics and recent tasks', async () => {
      await history.recordTask(createEntry({
        taskId: 'cli-001',
        title: 'Fix timeout issue',
        category: 'bug-fix',
        durationMs: 930000,
        iterations: 3,
        outcome: 'success',
      }));

      const summary = await history.getFormattedSummary();

      expect(summary).toContain('Task History');
      expect(summary).toContain('Fix timeout issue');
      expect(summary).toContain('bug-fix');
      expect(summary).toContain('✅');
    });
  });

  describe('getTask', () => {
    it('returns null for non-existent task', async () => {
      const result = await history.getTask('non-existent');
      expect(result).toBeNull();
    });

    it('returns the specific task entry', async () => {
      await history.recordTask(createEntry({ taskId: 'cli-001' }));
      await history.recordTask(createEntry({ taskId: 'cli-002' }));

      const result = await history.getTask('cli-001');
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('cli-001');
    });
  });

  describe('clear', () => {
    it('removes all history', async () => {
      await history.recordTask(createEntry());
      await history.clear();

      const result = await history.getTask('cli-001');
      expect(result).toBeNull();
    });
  });
});
