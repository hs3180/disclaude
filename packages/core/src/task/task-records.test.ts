/**
 * Tests for TaskRecordManager.
 *
 * Issue #1234 Phase 1: Task ETA estimation system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordManager, type TaskRecord } from './task-records.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-records-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskRecordManager', () => {
  let manager: TaskRecordManager;

  beforeEach(() => {
    manager = new TaskRecordManager({ baseDir: tempDir });
  });

  describe('constructor', () => {
    it('should create manager with default filename', () => {
      expect(manager.getFilePath()).toContain('.claude');
      expect(manager.getFilePath()).toContain('task-records.md');
    });

    it('should support custom filename', () => {
      const custom = new TaskRecordManager({ baseDir: tempDir, filename: 'custom.md' });
      expect(custom.getFilePath()).toContain('custom.md');
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      expect(await manager.exists()).toBe(false);
    });

    it('should return true after file is created', async () => {
      await manager.appendRecord(makeRecord({ title: 'Test' }));
      expect(await manager.exists()).toBe(true);
    });
  });

  describe('appendRecord', () => {
    it('should create file with header on first write', async () => {
      await manager.appendRecord(makeRecord());

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      expect(content).toContain('# 任务记录');
    });

    it('should append record in correct format', async () => {
      await manager.appendRecord(makeRecord({
        title: 'Fix login bug',
        type: 'bugfix',
        estimatedTime: '30分钟',
        estimationBasis: 'Similar to previous fix',
        actualTime: '45分钟',
        review: 'Underestimated complexity',
        date: '2026-05-12',
      }));

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      expect(content).toContain('## 2026-05-12 Fix login bug');
      expect(content).toContain('**类型**: bugfix');
      expect(content).toContain('**估计时间**: 30分钟');
      expect(content).toContain('**估计依据**: Similar to previous fix');
      expect(content).toContain('**实际时间**: 45分钟');
      expect(content).toContain('**复盘**: Underestimated complexity');
    });

    it('should append multiple records', async () => {
      await manager.appendRecord(makeRecord({ title: 'Task A', date: '2026-05-10' }));
      await manager.appendRecord(makeRecord({ title: 'Task B', date: '2026-05-11' }));

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      expect(content).toContain('Task A');
      expect(content).toContain('Task B');
    });
  });

  describe('appendRecordSync', () => {
    it('should write record synchronously', async () => {
      manager.appendRecordSync(makeRecord({ title: 'Sync task' }));

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      expect(content).toContain('Sync task');
    });
  });

  describe('readRecords', () => {
    it('should return empty array when file does not exist', async () => {
      const records = await manager.readRecords();
      expect(records).toEqual([]);
    });

    it('should parse a single record', async () => {
      await manager.appendRecord(makeRecord({
        title: 'Add export feature',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: 'Similar to report feature',
        actualTime: '55分钟',
        review: 'Estimate was accurate',
        date: '2026-05-09',
      }));

      const records = await manager.readRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Add export feature');
      expect(records[0].type).toBe('feature');
      expect(records[0].estimatedTime).toBe('1小时');
      expect(records[0].actualTime).toBe('55分钟');
    });

    it('should return records newest first', async () => {
      await manager.appendRecord(makeRecord({ title: 'First', date: '2026-05-01' }));
      await manager.appendRecord(makeRecord({ title: 'Second', date: '2026-05-02' }));
      await manager.appendRecord(makeRecord({ title: 'Third', date: '2026-05-03' }));

      const records = await manager.readRecords();
      expect(records).toHaveLength(3);
      expect(records[0].title).toBe('Third');
      expect(records[2].title).toBe('First');
    });

    it('should include rawSection in parsed records', async () => {
      await manager.appendRecord(makeRecord({ title: 'With raw' }));

      const records = await manager.readRecords();
      expect(records[0].rawSection).toContain('With raw');
      expect(records[0].rawSection).toContain('**类型**');
    });

    it('should handle special characters in fields', async () => {
      await manager.appendRecord(makeRecord({
        title: 'Fix: handle "quotes" & <brackets>',
        estimationBasis: 'Previous fix in #1234 (PR #5678)',
        review: 'Required changes to core/path.ts:42',
      }));

      const records = await manager.readRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Fix: handle "quotes" & <brackets>');
    });
  });

  describe('searchRecords', () => {
    beforeEach(async () => {
      await manager.appendRecord(makeRecord({
        title: 'Fix login bug',
        type: 'bugfix',
        review: 'Password validation was complex',
        date: '2026-05-10',
      }));
      await manager.appendRecord(makeRecord({
        title: 'Add user export',
        type: 'feature',
        review: 'Straightforward implementation',
        date: '2026-05-11',
      }));
    });

    it('should search by title', async () => {
      const results = await manager.searchRecords('login');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Fix login bug');
    });

    it('should search by type', async () => {
      const results = await manager.searchRecords('feature');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Add user export');
    });

    it('should search by review content', async () => {
      const results = await manager.searchRecords('password');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Fix login bug');
    });

    it('should be case-insensitive', async () => {
      const results = await manager.searchRecords('LOGIN');
      expect(results).toHaveLength(1);
    });

    it('should return empty for no match', async () => {
      const results = await manager.searchRecords('nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('getRecordsByType', () => {
    beforeEach(async () => {
      await manager.appendRecord(makeRecord({ title: 'Bug 1', type: 'bugfix', date: '2026-05-10' }));
      await manager.appendRecord(makeRecord({ title: 'Feature 1', type: 'feature', date: '2026-05-11' }));
      await manager.appendRecord(makeRecord({ title: 'Bug 2', type: 'bugfix', date: '2026-05-12' }));
    });

    it('should filter by bugfix type', async () => {
      const results = await manager.getRecordsByType('bugfix');
      expect(results).toHaveLength(2);
      expect(results.every(r => r.type === 'bugfix')).toBe(true);
    });

    it('should filter by feature type', async () => {
      const results = await manager.getRecordsByType('feature');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Feature 1');
    });

    it('should return empty for type with no records', async () => {
      const results = await manager.getRecordsByType('docs');
      expect(results).toHaveLength(0);
    });
  });
});

/** Helper to create a TaskRecord with sensible defaults */
function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    title: 'Test task',
    type: 'bugfix',
    estimatedTime: '30分钟',
    estimationBasis: 'Similar past task',
    actualTime: '35分钟',
    review: 'Minor underestimate',
    date: '2026-05-12',
    ...overrides,
  };
}
