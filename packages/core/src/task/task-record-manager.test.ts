/**
 * Tests for TaskRecordManager.
 *
 * Issue #1234 Phase 1: Task record format, storage, and retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordManager } from './task-record-manager.js';
import type { TaskRecord } from './types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskRecordManager', () => {
  let manager: TaskRecordManager;

  beforeEach(() => {
    manager = new TaskRecordManager({ workspaceDir: tempDir });
  });

  describe('constructor', () => {
    it('should create manager with workspace directory', () => {
      expect(manager).toBeInstanceOf(TaskRecordManager);
    });

    it('should use default filename task-records.md', () => {
      expect(manager.getRecordsPath()).toContain('task-records.md');
    });

    it('should support custom filename', () => {
      const custom = new TaskRecordManager({ workspaceDir: tempDir, filename: 'custom.md' });
      expect(custom.getRecordsPath()).toContain('custom.md');
    });
  });

  describe('ensureFile', () => {
    it('should create records file with header if not exists', async () => {
      await manager.ensureFile();

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('# 任务记录');
    });

    it('should not overwrite existing file', async () => {
      await manager.ensureFile();
      // Write some content
      await fs.appendFile(manager.getRecordsPath(), '## test\n', 'utf-8');

      await manager.ensureFile();

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('## test');
    });
  });

  describe('appendRecord', () => {
    it('should append a basic record to the file', async () => {
      const record: TaskRecord = {
        title: '重构登录模块',
        type: 'refactoring',
        startedAt: '2024-03-10T09:00:00Z',
        completedAt: '2024-03-10T09:45:00Z',
        estimatedMinutes: 30,
        estimationBasis: '类似之前的表单重构，当时花了25分钟',
        actualMinutes: 45,
        review: '低估了密码验证逻辑的复杂度',
      };

      await manager.appendRecord(record);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('## 2024-03-10 重构登录模块');
      expect(content).toContain('**类型**: refactoring');
      expect(content).toContain('**估计时间**: 30分钟');
      expect(content).toContain('**估计依据**: 类似之前的表单重构，当时花了25分钟');
      expect(content).toContain('**实际时间**: 45分钟');
      expect(content).toContain('**复盘**: 低估了密码验证逻辑的复杂度');
    });

    it('should append record without estimate', async () => {
      const record: TaskRecord = {
        title: '修复样式问题',
        type: 'bugfix',
        startedAt: '2024-03-11T10:00:00Z',
        completedAt: '2024-03-11T10:15:00Z',
        estimatedMinutes: null,
        estimationBasis: '',
        actualMinutes: 15,
        review: '快速修复',
      };

      await manager.appendRecord(record);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('## 2024-03-11 修复样式问题');
      expect(content).toContain('**类型**: bugfix');
      expect(content).not.toContain('**估计时间**');
      expect(content).toContain('**实际时间**: 15分钟');
    });

    it('should append record with tags', async () => {
      const record: TaskRecord = {
        title: '添加用户导出功能',
        type: 'feature-small',
        startedAt: '2024-03-09T14:00:00Z',
        completedAt: '2024-03-09T14:55:00Z',
        estimatedMinutes: 60,
        estimationBasis: '需要数据查询+格式转换+文件下载',
        actualMinutes: 55,
        review: '估计较准确',
        tags: ['export', 'api'],
      };

      await manager.appendRecord(record);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('**标签**: export, api');
    });

    it('should append multiple records sequentially', async () => {
      const record1: TaskRecord = {
        title: '任务一',
        type: 'bugfix',
        startedAt: '2024-03-01T09:00:00Z',
        completedAt: '2024-03-01T09:20:00Z',
        estimatedMinutes: null,
        estimationBasis: '',
        actualMinutes: 20,
        review: '',
      };

      const record2: TaskRecord = {
        title: '任务二',
        type: 'feature-small',
        startedAt: '2024-03-02T09:00:00Z',
        completedAt: '2024-03-02T10:00:00Z',
        estimatedMinutes: 45,
        estimationBasis: '',
        actualMinutes: 60,
        review: '',
      };

      await manager.appendRecord(record1);
      await manager.appendRecord(record2);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('## 2024-03-01 任务一');
      expect(content).toContain('## 2024-03-02 任务二');
    });
  });

  describe('readRecords', () => {
    it('should return empty array when file does not exist', async () => {
      const records = await manager.readRecords();
      expect(records).toEqual([]);
    });

    it('should parse single record from file', async () => {
      const record: TaskRecord = {
        title: '重构登录模块',
        type: 'refactoring',
        startedAt: '2024-03-10T09:00:00Z',
        completedAt: '2024-03-10T09:45:00Z',
        estimatedMinutes: 30,
        estimationBasis: '类似之前的表单重构',
        actualMinutes: 45,
        review: '低估了密码验证逻辑的复杂度',
      };

      await manager.appendRecord(record);
      const records = await manager.readRecords();

      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('重构登录模块');
      expect(records[0].type).toBe('refactoring');
      expect(records[0].estimatedMinutes).toBe(30);
      expect(records[0].actualMinutes).toBe(45);
      expect(records[0].review).toBe('低估了密码验证逻辑的复杂度');
    });

    it('should parse multiple records and return newest first', async () => {
      const record1: TaskRecord = {
        title: '旧任务',
        type: 'bugfix',
        startedAt: '2024-03-01T00:00:00Z',
        completedAt: '2024-03-01T00:20:00Z',
        estimatedMinutes: null,
        estimationBasis: '',
        actualMinutes: 20,
        review: '',
      };

      const record2: TaskRecord = {
        title: '新任务',
        type: 'feature-small',
        startedAt: '2024-03-02T00:00:00Z',
        completedAt: '2024-03-02T00:45:00Z',
        estimatedMinutes: 30,
        estimationBasis: '',
        actualMinutes: 45,
        review: '',
      };

      await manager.appendRecord(record1);
      await manager.appendRecord(record2);

      const records = await manager.readRecords();

      expect(records).toHaveLength(2);
      // Newest first (reverse order)
      expect(records[0].title).toBe('新任务');
      expect(records[1].title).toBe('旧任务');
    });

    it('should handle record without estimate', async () => {
      const record: TaskRecord = {
        title: '快速修复',
        type: 'bugfix',
        startedAt: '2024-03-11T10:00:00Z',
        completedAt: '2024-03-11T10:15:00Z',
        estimatedMinutes: null,
        estimationBasis: '',
        actualMinutes: 15,
        review: '',
      };

      await manager.appendRecord(record);
      const records = await manager.readRecords();

      expect(records[0].estimatedMinutes).toBeNull();
      expect(records[0].actualMinutes).toBe(15);
    });
  });

  describe('searchRecords', () => {
    beforeEach(async () => {
      // Set up test data
      const records: TaskRecord[] = [
        {
          title: '修复登录 bug',
          type: 'bugfix',
          startedAt: '2024-03-01T09:00:00Z',
          completedAt: '2024-03-01T09:30:00Z',
          estimatedMinutes: 20,
          estimationBasis: '常见 bug',
          actualMinutes: 30,
          review: '比预期复杂',
        },
        {
          title: '添加导出功能',
          type: 'feature-small',
          startedAt: '2024-03-05T09:00:00Z',
          completedAt: '2024-03-05T10:00:00Z',
          estimatedMinutes: 60,
          estimationBasis: '数据查询+格式转换',
          actualMinutes: 60,
          review: '估计准确',
        },
        {
          title: '重构数据库层',
          type: 'refactoring',
          startedAt: '2024-03-10T09:00:00Z',
          completedAt: '2024-03-10T12:00:00Z',
          estimatedMinutes: 120,
          estimationBasis: '大型重构任务',
          actualMinutes: 180,
          review: '需要更多时间测试',
        },
      ];

      for (const record of records) {
        await manager.appendRecord(record);
      }
    });

    it('should filter by type', async () => {
      const results = await manager.searchRecords({ type: 'bugfix' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('修复登录 bug');
    });

    it('should filter by keyword', async () => {
      const results = await manager.searchRecords({ keyword: '功能' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('添加导出功能');
    });

    it('should filter by keyword case-insensitively', async () => {
      const results = await manager.searchRecords({ keyword: 'BUG' });
      // "修复登录 bug" should match
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by date range', async () => {
      const results = await manager.searchRecords({
        dateFrom: '2024-03-04',
        dateTo: '2024-03-06',
      });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('添加导出功能');
    });

    it('should filter by date from only', async () => {
      const results = await manager.searchRecords({
        dateFrom: '2024-03-08',
      });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('重构数据库层');
    });

    it('should combine multiple criteria', async () => {
      const results = await manager.searchRecords({
        keyword: 'bug',
        dateFrom: '2024-03-01',
      });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('修复登录 bug');
    });

    it('should return empty when no matches', async () => {
      const results = await manager.searchRecords({ keyword: '不存在的内容' });
      expect(results).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should return empty stats when no records', async () => {
      const stats = await manager.getStats();

      expect(stats.totalRecords).toBe(0);
      expect(stats.estimationAccuracy).toBeNull();
    });

    it('should compute stats correctly', async () => {
      const records: TaskRecord[] = [
        {
          title: 'Bug fix 1',
          type: 'bugfix',
          startedAt: '2024-03-01T00:00:00Z',
          completedAt: '2024-03-01T00:20:00Z',
          estimatedMinutes: 15,
          estimationBasis: '',
          actualMinutes: 20,
          review: '',
        },
        {
          title: 'Bug fix 2',
          type: 'bugfix',
          startedAt: '2024-03-02T00:00:00Z',
          completedAt: '2024-03-02T00:30:00Z',
          estimatedMinutes: 20,
          estimationBasis: '',
          actualMinutes: 30,
          review: '',
        },
        {
          title: 'Feature',
          type: 'feature-small',
          startedAt: '2024-03-03T00:00:00Z',
          completedAt: '2024-03-03T01:00:00Z',
          estimatedMinutes: null,
          estimationBasis: '',
          actualMinutes: 60,
          review: '',
        },
      ];

      for (const record of records) {
        await manager.appendRecord(record);
      }

      const stats = await manager.getStats();

      expect(stats.totalRecords).toBe(3);
      expect(stats.averageByType['bugfix']).toEqual({ count: 2, avgMinutes: 25 });
      expect(stats.averageByType['feature-small']).toEqual({ count: 1, avgMinutes: 60 });
      // Estimation accuracy: avg of (20/15, 30/20) = avg of (1.33, 1.5) = 1.42
      expect(stats.estimationAccuracy).not.toBeNull();
      expect(stats.estimationAccuracy!.count).toBe(2);
      expect(stats.estimationAccuracy!.avgRatio).toBeCloseTo(1.42, 1);
    });
  });

  describe('round-trip consistency', () => {
    it('should preserve data through append → read cycle', async () => {
      const original: TaskRecord = {
        title: '集成测试：修复超时问题',
        type: 'bugfix',
        startedAt: '2024-03-15T10:00:00Z',
        completedAt: '2024-03-15T10:45:00Z',
        estimatedMinutes: 30,
        estimationBasis: '常见超时问题，通常需要调整超时配置',
        actualMinutes: 45,
        review: '需要同时修改客户端和服务端的超时设置',
        tags: ['timeout', 'network'],
      };

      await manager.appendRecord(original);
      const records = await manager.readRecords();

      expect(records).toHaveLength(1);
      const [parsed] = records;
      expect(parsed.title).toBe(original.title);
      expect(parsed.type).toBe(original.type);
      expect(parsed.estimatedMinutes).toBe(original.estimatedMinutes);
      expect(parsed.estimationBasis).toBe(original.estimationBasis);
      expect(parsed.actualMinutes).toBe(original.actualMinutes);
      expect(parsed.review).toBe(original.review);
      expect(parsed.tags).toEqual(original.tags);
    });
  });
});
