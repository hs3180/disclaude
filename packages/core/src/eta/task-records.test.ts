/**
 * Tests for TaskRecordManager.
 *
 * Verifies task record appending, parsing, searching, and ETA rules initialization.
 *
 * Issue #1234 Phase 1: Task ETA estimation system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordManager } from './task-records.js';
import type { TaskRecord } from './types.js';

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
    it('should use default paths when only baseDir is provided', () => {
      const m = new TaskRecordManager({ baseDir: tempDir });
      expect(m.getRecordsPath()).toBe(path.join(tempDir, '.claude', 'task-records.md'));
      expect(m.getRulesPath()).toBe(path.join(tempDir, '.claude', 'eta-rules.md'));
    });

    it('should use custom paths when provided', () => {
      const m = new TaskRecordManager({
        recordsPath: '/tmp/custom-records.md',
        rulesPath: '/tmp/custom-rules.md',
      });
      expect(m.getRecordsPath()).toBe('/tmp/custom-records.md');
      expect(m.getRulesPath()).toBe('/tmp/custom-rules.md');
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      expect(await manager.exists()).toBe(false);
    });

    it('should return true after a record is appended', async () => {
      await manager.appendRecord(makeRecord());
      expect(await manager.exists()).toBe(true);
    });
  });

  describe('appendRecord', () => {
    it('should create file with header on first append', async () => {
      await manager.appendRecord(makeRecord({ title: 'First task' }));

      const content = await manager.readRaw();
      expect(content).toContain('# 任务记录');
      expect(content).toContain('## 2026-05-16 First task');
    });

    it('should not duplicate header on subsequent appends', async () => {
      await manager.appendRecord(makeRecord({ title: 'Task A' }));
      await manager.appendRecord(makeRecord({ title: 'Task B' }));

      const content = await manager.readRaw();
      const headerCount = (content.match(/# 任务记录/g) || []).length;
      expect(headerCount).toBe(1);
    });

    it('should write all record fields', async () => {
      await manager.appendRecord(makeRecord());

      const content = await manager.readRaw();
      expect(content).toContain('**类型**: bugfix');
      expect(content).toContain('**估计时间**: 30分钟');
      expect(content).toContain('**估计依据**: Similar to previous fix');
      expect(content).toContain('**实际时间**: 45分钟');
      expect(content).toContain('**复盘**: Underestimated edge case');
    });

    it('should create parent directory if needed', async () => {
      await manager.appendRecord(makeRecord());

      const claudeDir = path.join(tempDir, '.claude');
      const stat = await fs.stat(claudeDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('listRecords', () => {
    it('should return empty array when no records exist', async () => {
      const records = await manager.listRecords();
      expect(records).toEqual([]);
    });

    it('should parse a single record', async () => {
      await manager.appendRecord(makeRecord());

      const records = await manager.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Fix WebSocket reconnection bug');
      expect(records[0].date).toBe('2026-05-16');
      expect(records[0].type).toBe('bugfix');
      expect(records[0].estimatedTime).toBe('30分钟');
      expect(records[0].estimationBasis).toBe('Similar to previous fix');
      expect(records[0].actualTime).toBe('45分钟');
      expect(records[0].review).toBe('Underestimated edge case');
      expect(records[0].lineNumber).toBe(3); // Line 1: header, Line 2: blank, Line 3: record
    });

    it('should parse multiple records', async () => {
      await manager.appendRecord(makeRecord({ title: 'Task A', date: '2026-05-14' }));
      await manager.appendRecord(makeRecord({ title: 'Task B', date: '2026-05-15' }));
      await manager.appendRecord(makeRecord({ title: 'Task C', date: '2026-05-16' }));

      const records = await manager.listRecords();
      expect(records).toHaveLength(3);
      expect(records[0].title).toBe('Task A');
      expect(records[1].title).toBe('Task B');
      expect(records[2].title).toBe('Task C');
    });
  });

  describe('listByType', () => {
    it('should filter records by type', async () => {
      await manager.appendRecord(makeRecord({ type: 'bugfix' }));
      await manager.appendRecord(makeRecord({ type: 'feature', title: 'Add export' }));
      await manager.appendRecord(makeRecord({ type: 'bugfix', title: 'Fix crash' }));

      const bugfixes = await manager.listByType('bugfix');
      expect(bugfixes).toHaveLength(2);

      const features = await manager.listByType('feature');
      expect(features).toHaveLength(1);
    });
  });

  describe('listByDateRange', () => {
    it('should filter records by date range', async () => {
      await manager.appendRecord(makeRecord({ date: '2026-05-10', title: 'Old task' }));
      await manager.appendRecord(makeRecord({ date: '2026-05-15', title: 'Mid task' }));
      await manager.appendRecord(makeRecord({ date: '2026-05-20', title: 'New task' }));

      const filtered = await manager.listByDateRange('2026-05-12', '2026-05-18');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Mid task');
    });

    it('should include boundary dates', async () => {
      await manager.appendRecord(makeRecord({ date: '2026-05-10', title: 'Boundary start' }));
      await manager.appendRecord(makeRecord({ date: '2026-05-15', title: 'Boundary end' }));

      const filtered = await manager.listByDateRange('2026-05-10', '2026-05-15');
      expect(filtered).toHaveLength(2);
    });
  });

  describe('search', () => {
    it('should search by title', async () => {
      await manager.appendRecord(makeRecord({ title: 'Fix login bug' }));
      await manager.appendRecord(makeRecord({ title: 'Add export feature' }));

      const results = await manager.search('login');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Fix login bug');
    });

    it('should search by estimation basis', async () => {
      await manager.appendRecord(makeRecord({
        title: 'Task A',
        estimationBasis: 'Similar to OAuth integration task',
      }));
      await manager.appendRecord(makeRecord({
        title: 'Task B',
        estimationBasis: 'New feature with no reference',
      }));

      const results = await manager.search('OAuth');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Task A');
    });

    it('should be case insensitive', async () => {
      await manager.appendRecord(makeRecord({ title: 'Fix WebSocket Bug' }));

      const results = await manager.search('websocket');
      expect(results).toHaveLength(1);
    });
  });

  describe('recent', () => {
    it('should return the most recent N records', async () => {
      for (let i = 1; i <= 5; i++) {
        await manager.appendRecord(makeRecord({ title: `Task ${i}`, date: `2026-05-${String(i).padStart(2, '0')}` }));
      }

      const recent = await manager.recent(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].title).toBe('Task 3');
      expect(recent[2].title).toBe('Task 5');
    });

    it('should return all records if count exceeds total', async () => {
      await manager.appendRecord(makeRecord());
      const recent = await manager.recent(10);
      expect(recent).toHaveLength(1);
    });
  });

  describe('initializeRulesTemplate', () => {
    it('should create rules template file if it does not exist', async () => {
      await manager.initializeRulesTemplate();

      const content = await fs.readFile(manager.getRulesPath(), 'utf-8');
      expect(content).toContain('ETA 估计规则');
      expect(content).toContain('任务类型基准时间');
      expect(content).toContain('bugfix');
      expect(content).toContain('经验规则');
    });

    it('should not overwrite existing rules file', async () => {
      const rulesPath = manager.getRulesPath();
      await fs.mkdir(path.dirname(rulesPath), { recursive: true });
      await fs.writeFile(rulesPath, 'My custom rules', 'utf-8');

      await manager.initializeRulesTemplate();

      const content = await fs.readFile(rulesPath, 'utf-8');
      expect(content).toBe('My custom rules');
    });
  });
});

// Helper to create a TaskRecord with defaults
function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    title: overrides.title ?? 'Fix WebSocket reconnection bug',
    date: overrides.date ?? '2026-05-16',
    type: overrides.type ?? 'bugfix',
    estimatedTime: overrides.estimatedTime ?? '30分钟',
    estimationBasis: overrides.estimationBasis ?? 'Similar to previous fix',
    actualTime: overrides.actualTime ?? '45分钟',
    review: overrides.review ?? 'Underestimated edge case',
  };
}
