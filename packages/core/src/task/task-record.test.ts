/**
 * Tests for TaskRecordManager.
 *
 * Issue #1234 Phase 1: Tests for task record management module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskRecordManager, type TaskRecordEntry } from './task-record.js';

describe('TaskRecordManager', () => {
  let tmpDir: string;
  let manager: TaskRecordManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-test-'));
    manager = new TaskRecordManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('ensureFile', () => {
    it('should create the record file with template if it does not exist', async () => {
      await manager.ensureFile();

      const exists = await manager.exists();
      expect(exists).toBe(true);

      const content = await manager.readRecords();
      expect(content).toContain('任务执行记录');
      expect(content).toContain('记录格式');
    });

    it('should not overwrite existing record file', async () => {
      await manager.ensureFile();

      // Append some content
      const recordFile = manager.getRecordFilePath();
      await fs.appendFile(recordFile, '\n### test record\n', 'utf-8');

      // Call ensureFile again
      await manager.ensureFile();

      const content = await manager.readRecords();
      expect(content).toContain('test record');
    });

    it('should create .claude directory if needed', async () => {
      const claudeDir = path.join(tmpDir, '.claude');
      await expect(fs.access(claudeDir)).rejects.toThrow();

      await manager.ensureFile();

      await expect(fs.access(claudeDir)).resolves.toBeUndefined();
    });
  });

  describe('appendRecord', () => {
    it('should append a task record to the file', async () => {
      const entry: TaskRecordEntry = {
        title: 'Fix login authentication bug',
        type: 'bugfix',
        taskId: 'om_test123',
        iterations: 2,
        actualTime: '30分钟',
        review: 'Auth logic was more complex than expected',
      };

      await manager.appendRecord(entry);

      const content = await manager.readRecords();
      expect(content).toContain('Fix login authentication bug');
      expect(content).toContain('bugfix');
      expect(content).toContain('om_test123');
      expect(content).toContain('30分钟');
      expect(content).toContain('Auth logic was more complex than expected');
    });

    it('should append multiple records in order', async () => {
      const entry1: TaskRecordEntry = {
        title: 'Task One',
        type: 'feature',
        taskId: 'om_001',
        iterations: 1,
        actualTime: '10分钟',
        review: 'Simple task',
      };

      const entry2: TaskRecordEntry = {
        title: 'Task Two',
        type: 'refactoring',
        taskId: 'om_002',
        iterations: 3,
        actualTime: '1小时',
        review: 'Needed multiple iterations',
      };

      await manager.appendRecord(entry1);
      await manager.appendRecord(entry2);

      const content = await manager.readRecords();
      expect(content).toContain('Task One');
      expect(content).toContain('Task Two');
      // Task Two should come after Task One
      const idx1 = content.indexOf('Task One');
      const idx2 = content.indexOf('Task Two');
      expect(idx2).toBeGreaterThan(idx1);
    });

    it('should create the file if it does not exist', async () => {
      expect(await manager.exists()).toBe(false);

      const entry: TaskRecordEntry = {
        title: 'First Task',
        type: 'test',
        taskId: 'om_first',
        iterations: 1,
        actualTime: '5分钟',
        review: 'Initial test',
      };

      await manager.appendRecord(entry);
      expect(await manager.exists()).toBe(true);
    });
  });

  describe('parseRecords', () => {
    it('should parse records from the file', async () => {
      const entry: TaskRecordEntry = {
        title: 'Fix login bug',
        type: 'bugfix',
        taskId: 'om_abc',
        iterations: 2,
        actualTime: '45分钟',
        review: 'Password validation was complex',
        timestamp: new Date('2024-03-10T14:30:00Z'),
      };

      await manager.appendRecord(entry);

      const records = await manager.parseRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Fix login bug');
      expect(records[0].type).toBe('bugfix');
      expect(records[0].taskId).toBe('om_abc');
      expect(records[0].iterations).toBe(2);
      expect(records[0].actualTime).toBe('45分钟');
      expect(records[0].review).toBe('Password validation was complex');
    });

    it('should parse multiple records', async () => {
      const entries: TaskRecordEntry[] = [
        { title: 'Task 1', type: 'feature', taskId: 'om_1', iterations: 1, actualTime: '10分钟', review: 'Easy' },
        { title: 'Task 2', type: 'bugfix', taskId: 'om_2', iterations: 3, actualTime: '1小时', review: 'Complex' },
        { title: 'Task 3', type: 'refactoring', taskId: 'om_3', iterations: 2, actualTime: '30分钟', review: 'Medium' },
      ];

      for (const entry of entries) {
        await manager.appendRecord(entry);
      }

      const records = await manager.parseRecords();
      expect(records).toHaveLength(3);
      expect(records.map(r => r.taskId)).toEqual(['om_1', 'om_2', 'om_3']);
    });

    it('should return empty array when no records exist', async () => {
      await manager.ensureFile();
      const records = await manager.parseRecords();
      expect(records).toHaveLength(0);
    });
  });

  describe('searchByType', () => {
    it('should filter records by type', async () => {
      const entries: TaskRecordEntry[] = [
        { title: 'Bug fix 1', type: 'bugfix', taskId: 'om_1', iterations: 1, actualTime: '10分钟', review: '' },
        { title: 'Feature 1', type: 'feature', taskId: 'om_2', iterations: 2, actualTime: '30分钟', review: '' },
        { title: 'Bug fix 2', type: 'bugfix', taskId: 'om_3', iterations: 1, actualTime: '15分钟', review: '' },
      ];

      for (const entry of entries) {
        await manager.appendRecord(entry);
      }

      const bugfixRecords = await manager.searchByType('bugfix');
      expect(bugfixRecords).toHaveLength(2);
      expect(bugfixRecords.every(r => r.type === 'bugfix')).toBe(true);
    });
  });

  describe('searchByKeyword', () => {
    it('should search by keyword in title and review', async () => {
      const entries: TaskRecordEntry[] = [
        { title: 'Fix authentication bug', type: 'bugfix', taskId: 'om_1', iterations: 2, actualTime: '30分钟', review: 'Auth was tricky' },
        { title: 'Add export feature', type: 'feature', taskId: 'om_2', iterations: 1, actualTime: '20分钟', review: 'Simple implementation' },
        { title: 'Update auth middleware', type: 'refactoring', taskId: 'om_3', iterations: 1, actualTime: '15分钟', review: 'Clean auth flow' },
      ];

      for (const entry of entries) {
        await manager.appendRecord(entry);
      }

      const authRecords = await manager.searchByKeyword('auth');
      expect(authRecords).toHaveLength(2); // "Fix authentication bug" and "Update auth middleware"
    });

    it('should be case insensitive', async () => {
      const entry: TaskRecordEntry = {
        title: 'Fix LOGIN Bug',
        type: 'bugfix',
        taskId: 'om_1',
        iterations: 1,
        actualTime: '10分钟',
        review: 'Login issue',
      };

      await manager.appendRecord(entry);

      const results = await manager.searchByKeyword('login');
      expect(results).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('should return aggregate statistics', async () => {
      const entries: TaskRecordEntry[] = [
        { title: 'Bug 1', type: 'bugfix', taskId: 'om_1', iterations: 2, actualTime: '20分钟', review: '' },
        { title: 'Bug 2', type: 'bugfix', taskId: 'om_2', iterations: 4, actualTime: '40分钟', review: '' },
        { title: 'Feature 1', type: 'feature', taskId: 'om_3', iterations: 1, actualTime: '15分钟', review: '' },
      ];

      for (const entry of entries) {
        await manager.appendRecord(entry);
      }

      const stats = await manager.getStats();
      expect(stats.totalRecords).toBe(3);
      expect(stats.byType.bugfix).toBe(2);
      expect(stats.byType.feature).toBe(1);
      // Average: (2 + 4 + 1) / 3 ≈ 2.33
      expect(stats.averageIterations).toBeCloseTo(2.33, 1);
    });

    it('should return zero stats when no records exist', async () => {
      await manager.ensureFile();

      const stats = await manager.getStats();
      expect(stats.totalRecords).toBe(0);
      expect(stats.averageIterations).toBe(0);
    });
  });
});
