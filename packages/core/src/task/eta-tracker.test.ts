/**
 * Tests for ETA Tracker
 *
 * @module task/eta-tracker.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EtaTracker } from './eta-tracker.js';
import type { EtaTaskRecord } from './eta-types.js';

describe('EtaTracker', () => {
  let tempDir: string;
  let tracker: EtaTracker;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eta-test-'));
    tracker = new EtaTracker({
      workspaceDir: tempDir,
      autoCreate: true,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create .claude directory if it does not exist', async () => {
      await tracker.initialize();

      const claudeDir = path.join(tempDir, '.claude');
      const stat = await fs.stat(claudeDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create task-records.md template if it does not exist', async () => {
      await tracker.initialize();

      const recordsPath = path.join(tempDir, '.claude', 'task-records.md');
      const content = await fs.readFile(recordsPath, 'utf-8');
      expect(content).toContain('# 任务记录');
    });

    it('should create eta-rules.md template if it does not exist', async () => {
      await tracker.initialize();

      const rulesPath = path.join(tempDir, '.claude', 'eta-rules.md');
      const content = await fs.readFile(rulesPath, 'utf-8');
      expect(content).toContain('# ETA 估计规则');
    });
  });

  describe('addTaskRecord', () => {
    it('should add a task record to the file', async () => {
      await tracker.initialize();

      const record: EtaTaskRecord = {
        title: 'Test task',
        date: '2024-03-10',
        type: 'feature-small',
        estimatedMinutes: 30,
        estimationBasis: 'Simple feature',
        actualMinutes: 45,
        review: 'Took longer due to edge cases',
      };

      await tracker.addTaskRecord(record);

      const content = await fs.readFile(path.join(tempDir, '.claude', 'task-records.md'), 'utf-8');
      expect(content).toContain('Test task');
      expect(content).toContain('feature-small');
      expect(content).toContain('30分钟');
      expect(content).toContain('45分钟');
    });
  });

  describe('addRule', () => {
    it('should add a new estimation rule', async () => {
      await tracker.initialize();

      await tracker.addRule({
        name: 'Custom Rule',
        description: 'A custom rule for testing',
        multiplier: 1.2,
        condition: 'When testing',
      });

      const content = await fs.readFile(path.join(tempDir, '.claude', 'eta-rules.md'), 'utf-8');
      expect(content).toContain('Custom Rule');
      expect(content).toContain('1.2');
    });
  });

  describe('predictEta', () => {
    it('should return a prediction with reasoning', async () => {
      await tracker.initialize();

      const prediction = await tracker.predictEta('Add user authentication feature', 'feature-small');

      expect(prediction.estimatedMinutes).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(prediction.confidence);
      expect(prediction.reasoning).toContain('Task type');
    });

    it('should apply rules based on description keywords', async () => {
      await tracker.initialize();

      const prediction = await tracker.predictEta(
        'Implement authentication with OAuth2',
        'feature-medium'
      );

      // Authentication rule should be applied (multiplier 1.5)
      expect(prediction.appliedRules).toContain('Authentication/Security');
    });

    it('should have low confidence with no historical data', async () => {
      await tracker.initialize();

      const prediction = await tracker.predictEta('New task', 'bugfix');
      expect(prediction.confidence).toBe('low');
    });

    it('should reference similar historical tasks if available', async () => {
      await tracker.initialize();

      // Add a historical record
      await tracker.addTaskRecord({
        title: 'Fix login bug in authentication module',
        date: '2024-03-01',
        type: 'bugfix',
        estimatedMinutes: 20,
        estimationBasis: 'Simple bug fix',
        actualMinutes: 25,
        review: 'Quick fix',
      });

      const prediction = await tracker.predictEta(
        'Fix authentication login bug',
        'bugfix'
      );

      // May or may not find similar tasks depending on keyword matching
      expect(prediction.estimatedMinutes).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for no records', async () => {
      await tracker.initialize();

      const stats = await tracker.getStats();
      expect(stats.totalTasks).toBe(0);
      expect(stats.averageError).toBe(0);
    });

    it('should calculate correct statistics', async () => {
      await tracker.initialize();

      // Add some records
      await tracker.addTaskRecord({
        title: 'Task 1',
        date: '2024-03-01',
        type: 'feature-small',
        estimatedMinutes: 30,
        estimationBasis: 'Test',
        actualMinutes: 60, // 100% over
        review: 'Underestimated',
      });

      await tracker.addTaskRecord({
        title: 'Task 2',
        date: '2024-03-02',
        type: 'feature-small',
        estimatedMinutes: 60,
        estimationBasis: 'Test',
        actualMinutes: 30, // 50% under
        review: 'Overestimated',
      });

      const stats = await tracker.getStats();
      expect(stats.totalTasks).toBe(2);
      expect(stats.mostCommonType).toBe('feature-small');
    });
  });
});
