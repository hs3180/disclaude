/**
 * Unit tests for TaskHistory (Issue #857)
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
    history = new TaskHistory(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const makeEntry = (overrides: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry => ({
    taskId: 'test-1',
    description: 'Test task',
    durationMs: 5000,
    toolCallCount: 3,
    stepCount: 2,
    success: true,
    completedAt: new Date().toISOString(),
    ...overrides,
  });

  describe('record', () => {
    it('should persist a task entry to disk', async () => {
      await history.record(makeEntry());

      const data = JSON.parse(await fs.readFile(path.join(tmpDir, 'task-history.json'), 'utf-8'));
      expect(data).toHaveLength(1);
      expect(data[0].taskId).toBe('test-1');
    });

    it('should append multiple entries', async () => {
      await history.record(makeEntry({ taskId: 'a' }));
      await history.record(makeEntry({ taskId: 'b' }));

      const data = JSON.parse(await fs.readFile(path.join(tmpDir, 'task-history.json'), 'utf-8'));
      expect(data).toHaveLength(2);
    });

    it('should cap at MAX_HISTORY_SIZE entries', async () => {
      for (let i = 0; i < 110; i++) {
        await history.record(makeEntry({ taskId: `task-${i}` }));
      }

      const data = JSON.parse(await fs.readFile(path.join(tmpDir, 'task-history.json'), 'utf-8'));
      expect(data).toHaveLength(100);
      // Should keep the most recent entries
      expect(data[0].taskId).toBe('task-10');
    });
  });

  describe('getSummary', () => {
    it('should return empty summary when no history', async () => {
      const summary = await history.getSummary();
      expect(summary.totalTasks).toBe(0);
      expect(summary.successRate).toBe(0);
    });

    it('should calculate correct statistics', async () => {
      await history.record(makeEntry({ success: true, durationMs: 10000, toolCallCount: 5, stepCount: 3 }));
      await history.record(makeEntry({ success: true, durationMs: 20000, toolCallCount: 10, stepCount: 5 }));
      await history.record(makeEntry({ success: false, durationMs: 5000, toolCallCount: 2, stepCount: 1 }));

      const summary = await history.getSummary();
      expect(summary.totalTasks).toBe(3);
      expect(summary.successRate).toBeCloseTo(2 / 3);
      expect(summary.avgDurationMs).toBe(15000); // avg of successful only
      expect(summary.avgToolCalls).toBe(Math.round(17 / 3)); // Math.round(5.67) = 6
    });
  });

  describe('getSummaryText', () => {
    it('should format summary for empty history', async () => {
      const text = await history.getSummaryText();
      expect(text).toContain('No past task records');
    });

    it('should format summary with data', async () => {
      await history.record(makeEntry({ success: true, durationMs: 60000 }));
      const text = await history.getSummaryText();
      expect(text).toContain('Past task statistics');
      expect(text).toContain('Success rate:');
    });
  });

  describe('getRecent', () => {
    it('should return recent entries in reverse order', async () => {
      for (let i = 0; i < 5; i++) {
        await history.record(makeEntry({ taskId: `task-${i}` }));
      }

      const recent = await history.getRecent(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].taskId).toBe('task-4');
      expect(recent[1].taskId).toBe('task-3');
    });
  });
});
