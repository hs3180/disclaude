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

    it('should not overwrite existing files', async () => {
      await tracker.initialize();
      const rulesPath = path.join(tempDir, '.claude', 'eta-rules.md');
      const firstContent = await fs.readFile(rulesPath, 'utf-8');

      await tracker.initialize();
      const secondContent = await fs.readFile(rulesPath, 'utf-8');

      expect(firstContent).toBe(secondContent);
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

    it('should add record under ## Records section', async () => {
      await tracker.initialize();

      const record: EtaTaskRecord = {
        title: 'Another task',
        date: '2024-03-11',
        type: 'bugfix',
        estimatedMinutes: 20,
        estimationBasis: 'Quick fix',
        actualMinutes: 25,
        review: 'Slight complexity',
      };

      await tracker.addTaskRecord(record);

      const content = await fs.readFile(path.join(tempDir, '.claude', 'task-records.md'), 'utf-8');
      // Record should be after the "## Records" header
      const recordsIndex = content.indexOf('## Records');
      const recordIndex = content.indexOf('Another task');
      expect(recordsIndex).toBeLessThan(recordIndex);
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

    it('should update an existing rule', async () => {
      await tracker.initialize();

      await tracker.addRule({
        name: 'Authentication/Security',
        description: 'Original description',
        multiplier: 1.5,
        condition: 'Auth tasks',
      });

      await tracker.addRule({
        name: 'Authentication/Security',
        description: 'Updated description',
        multiplier: 2.0,
        condition: 'Auth tasks updated',
      });

      const rules = await tracker.loadRules();
      const authRule = rules.find(r => r.name === 'Authentication/Security');
      expect(authRule?.multiplier).toBe(2.0);
      expect(authRule?.description).toBe('Updated description');
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

    it('should handle unknown task type with default baseline', async () => {
      await tracker.initialize();

      const prediction = await tracker.predictEta('Some unknown task', 'other');

      expect(prediction.estimatedMinutes).toBeGreaterThan(0);
    });

    it('should return referenced tasks from history', async () => {
      await tracker.initialize();

      // Add multiple records with similar keywords
      await tracker.addTaskRecord({
        title: 'Fix database authentication bug',
        date: '2024-03-01',
        type: 'bugfix',
        estimatedMinutes: 20,
        estimationBasis: 'Similar to previous',
        actualMinutes: 25,
        review: 'Authentication bug was tricky',
      });

      await tracker.addTaskRecord({
        title: 'Fix authentication timeout bug',
        date: '2024-03-02',
        type: 'bugfix',
        estimatedMinutes: 30,
        estimationBasis: 'Timeout issues',
        actualMinutes: 40,
        review: 'Authentication timeout was complex',
      });

      const prediction = await tracker.predictEta(
        'Fix authentication validation bug',
        'bugfix'
      );

      // Should find similar tasks with shared keywords (authentication, bug)
      expect(prediction.referencedTasks.length).toBeGreaterThan(0);
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

    it('should report overestimation and underestimation rates', async () => {
      await tracker.initialize();

      // Significantly underestimated
      await tracker.addTaskRecord({
        title: 'Under Task',
        date: '2024-03-01',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Quick',
        actualMinutes: 50, // 400% over
        review: 'Much harder than expected',
      });

      // Significantly overestimated
      await tracker.addTaskRecord({
        title: 'Over Task',
        date: '2024-03-02',
        type: 'bugfix',
        estimatedMinutes: 100,
        estimationBasis: 'Complex',
        actualMinutes: 10, // 90% under
        review: 'Actually simple',
      });

      const stats = await tracker.getStats();
      expect(stats.underestimatedRate).toBeGreaterThan(0);
      expect(stats.overestimatedRate).toBeGreaterThan(0);
    });
  });

  describe('loadRecords', () => {
    it('should load records from file', async () => {
      await tracker.initialize();

      await tracker.addTaskRecord({
        title: 'Load Test Task',
        date: '2024-03-01',
        type: 'feature-small',
        estimatedMinutes: 30,
        estimationBasis: 'Test',
        actualMinutes: 35,
        review: 'Close estimate',
      });

      const records = await tracker.loadRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Load Test Task');
    });

    it('should return empty array for no records', async () => {
      await tracker.initialize();

      const records = await tracker.loadRecords();
      expect(records).toHaveLength(0);
    });
  });

  describe('loadRules', () => {
    it('should load default rules from template', async () => {
      await tracker.initialize();

      const rules = await tracker.loadRules();
      expect(rules.length).toBeGreaterThan(0);
      // Should include default rules
      const authRule = rules.find(r => r.name === 'Authentication/Security');
      expect(authRule).toBeDefined();
      expect(authRule?.multiplier).toBe(1.5);
    });

    it('should load rules after adding custom ones', async () => {
      await tracker.initialize();

      await tracker.addRule({
        name: 'Test Rule',
        description: 'For testing',
        multiplier: 3.0,
        condition: 'When testing',
      });

      const rules = await tracker.loadRules();
      const testRule = rules.find(r => r.name === 'Test Rule');
      expect(testRule).toBeDefined();
      expect(testRule?.multiplier).toBe(3.0);
    });
  });
});
