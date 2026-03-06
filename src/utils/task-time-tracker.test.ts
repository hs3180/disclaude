/**
 * Tests for Task Time Tracker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskTimeTracker, resetTaskTimeTracker, getTaskTimeTracker } from './task-time-tracker.js';

describe('TaskTimeTracker', () => {
  let tempDir: string;
  let tracker: TaskTimeTracker;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-time-tracker-'));
    tracker = new TaskTimeTracker(tempDir);
    resetTaskTimeTracker();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    resetTaskTimeTracker();
  });

  describe('recordTask', () => {
    it('should record a task with timing information', async () => {
      const record = await tracker.recordTask(
        'code-review',
        'moderate',
        120,
        150,
        'success'
      );

      expect(record.id).toBeDefined();
      expect(record.taskType).toBe('code-review');
      expect(record.complexity).toBe('moderate');
      expect(record.estimatedSeconds).toBe(120);
      expect(record.actualSeconds).toBe(150);
      expect(record.outcome).toBe('success');
    });

    it('should record task with notes', async () => {
      const record = await tracker.recordTask(
        'refactoring',
        'complex',
        600,
        900,
        'partial',
        'Had to refactor more files than expected'
      );

      expect(record.notes).toBe('Had to refactor more files than expected');
    });
  });

  describe('getRecentRecords', () => {
    it('should return recent records', async () => {
      await tracker.recordTask('task1', 'simple', 30, 25);
      await tracker.recordTask('task2', 'moderate', 120, 150);

      const records = await tracker.getRecentRecords();

      expect(records).toHaveLength(2);
      expect(records[0].taskType).toBe('task1');
      expect(records[1].taskType).toBe('task2');
    });

    it('should limit results', async () => {
      await tracker.recordTask('task1', 'simple', 30, 25);
      await tracker.recordTask('task2', 'simple', 30, 25);
      await tracker.recordTask('task3', 'simple', 30, 25);

      const records = await tracker.getRecentRecords(2);

      expect(records).toHaveLength(2);
      // Should return most recent
      expect(records[0].taskType).toBe('task2');
      expect(records[1].taskType).toBe('task3');
    });
  });

  describe('getEstimationGuidance', () => {
    it('should return default guidance when no records exist', async () => {
      const guidance = await tracker.getEstimationGuidance();

      expect(guidance).toContain('Time Estimation Reference');
      expect(guidance).toContain('Simple');
      expect(guidance).toContain('Moderate');
      expect(guidance).toContain('Complex');
    });

    it('should include historical data after recording tasks', async () => {
      await tracker.recordTask('quick-lookup', 'simple', 30, 25);
      await tracker.recordTask('code-review', 'moderate', 120, 150);

      const guidance = await tracker.getEstimationGuidance();

      expect(guidance).toContain('Historical Time Reference');
      expect(guidance).toContain('Simple');
      expect(guidance).toContain('Moderate');
    });
  });

  describe('getAccuracySummary', () => {
    it('should return empty summary when no records', async () => {
      const summary = await tracker.getAccuracySummary();

      expect(summary.simple.count).toBe(0);
      expect(summary.moderate.count).toBe(0);
      expect(summary.complex.count).toBe(0);
    });

    it('should calculate accuracy by complexity', async () => {
      // Record some tasks
      await tracker.recordTask('task1', 'simple', 30, 30); // 100% accuracy
      await tracker.recordTask('task2', 'simple', 30, 60); // 200% accuracy
      await tracker.recordTask('task3', 'complex', 600, 900); // 150% accuracy

      const summary = await tracker.getAccuracySummary();

      expect(summary.simple.count).toBe(2);
      expect(summary.complex.count).toBe(1);
      // Average accuracy for simple: (1.0 + 2.0) / 2 = 1.5
      expect(summary.simple.avgAccuracy).toBeCloseTo(1.5, 1);
    });
  });

  describe('persistence', () => {
    it('should persist records across instances', async () => {
      await tracker.recordTask('persistent-task', 'moderate', 120, 150);

      // Create new tracker with same directory
      const newTracker = new TaskTimeTracker(tempDir);
      const records = await newTracker.getRecentRecords();

      expect(records).toHaveLength(1);
      expect(records[0].taskType).toBe('persistent-task');
    });
  });
});

describe('getTaskTimeTracker', () => {
  beforeEach(() => {
    resetTaskTimeTracker();
  });

  afterEach(() => {
    resetTaskTimeTracker();
  });

  it('should return singleton instance', () => {
    const tracker1 = getTaskTimeTracker();
    const tracker2 = getTaskTimeTracker();

    expect(tracker1).toBe(tracker2);
  });

  it('should reset singleton', () => {
    const tracker1 = getTaskTimeTracker();
    resetTaskTimeTracker();
    const tracker2 = getTaskTimeTracker();

    expect(tracker1).not.toBe(tracker2);
  });
});
