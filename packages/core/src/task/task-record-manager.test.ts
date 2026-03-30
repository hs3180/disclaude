/**
 * Unit tests for TaskRecordManager.
 *
 * Tests cover:
 * - File creation with default header
 * - Appending task records
 * - Updating records with actual time and retrospective
 * - Reading and searching records
 * - Parsing records into structured data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskRecordManager } from './task-record-manager.js';
import type { TaskRecord } from './types.js';

describe('TaskRecordManager', () => {
  let manager: TaskRecordManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-test-'));
    manager = new TaskRecordManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should set records file path to .claude/task-records.md', () => {
      const expected = path.join(tempDir, '.claude', 'task-records.md');
      expect(manager.getRecordsFilePath()).toBe(expected);
    });
  });

  describe('appendRecord', () => {
    it('should create .claude directory and task-records.md on first write', async () => {
      const record: TaskRecord = {
        title: '修复登录 Bug',
        type: 'bugfix',
        estimatedTime: '30分钟',
        estimationBasis: '简单的表单验证问题',
      };

      await manager.appendRecord(record);

      const content = await fs.readFile(manager.getRecordsFilePath(), 'utf-8');
      expect(content).toContain('# 任务记录');
      expect(content).toContain('修复登录 Bug');
      expect(content).toContain('bugfix');
      expect(content).toContain('30分钟');
    });

    it('should append multiple records in order', async () => {
      const record1: TaskRecord = {
        title: '添加用户导出功能',
        type: 'feature-small',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询 + 格式转换',
        date: '2024-03-09',
      };

      const record2: TaskRecord = {
        title: '重构登录模块',
        type: 'refactoring',
        estimatedTime: '30分钟',
        estimationBasis: '类似之前的表单重构',
        date: '2024-03-10',
      };

      await manager.appendRecord(record1);
      await manager.appendRecord(record2);

      const content = await manager.getRecords();
      const firstIndex = content.indexOf('2024-03-09');
      const secondIndex = content.indexOf('2024-03-10');
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it('should include actualTime and retrospective when provided', async () => {
      const record: TaskRecord = {
        title: '添加缓存层',
        type: 'feature-medium',
        estimatedTime: '2小时',
        estimationBasis: '需要 Redis 集成',
        actualTime: '3小时',
        retrospective: '低估了缓存失效策略的复杂度',
      };

      await manager.appendRecord(record);

      const content = await manager.getRecords();
      expect(content).toContain('**实际时间**: 3小时');
      expect(content).toContain('**复盘**: 低估了缓存失效策略的复杂度');
    });

    it('should include taskId when provided', async () => {
      const record: TaskRecord = {
        title: '修复 API 超时',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单的超时配置修改',
        taskId: 'issue-123',
      };

      await manager.appendRecord(record);

      const content = await manager.getRecords();
      expect(content).toContain('**任务 ID**: issue-123');
    });

    it('should default date to today when not provided', async () => {
      const record: TaskRecord = {
        title: '测试任务',
        type: 'chore',
        estimatedTime: '10分钟',
        estimationBasis: '简单的配置更新',
      };

      await manager.appendRecord(record);

      const content = await manager.getRecords();
      const [today] = new Date().toISOString().split('T');
      expect(content).toContain(today);
    });

    it('should handle custom task types', async () => {
      const record: TaskRecord = {
        title: '部署流程优化',
        type: 'devops',
        estimatedTime: '4小时',
        estimationBasis: '需要修改 CI/CD 配置',
      };

      await manager.appendRecord(record);

      const content = await manager.getRecords();
      expect(content).toContain('**类型**: devops');
    });
  });

  describe('updateRecord', () => {
    it('should update actualTime for an existing record', async () => {
      const record: TaskRecord = {
        title: '添加搜索功能',
        type: 'feature-small',
        estimatedTime: '1小时',
        estimationBasis: '简单的全文搜索集成',
        date: '2024-03-15',
      };

      await manager.appendRecord(record);
      const updated = await manager.updateRecord('添加搜索功能', { actualTime: '2小时' });

      expect(updated).toBe(true);

      const content = await manager.getRecords();
      expect(content).toContain('**实际时间**: 2小时');
    });

    it('should update retrospective for an existing record', async () => {
      const record: TaskRecord = {
        title: '数据库迁移',
        type: 'feature-medium',
        estimatedTime: '3小时',
        estimationBasis: '需要迁移 5 个表',
        date: '2024-03-16',
      };

      await manager.appendRecord(record);
      const updated = await manager.updateRecord('数据库迁移', {
        retrospective: '低估了数据验证和回滚策略的工作量',
      });

      expect(updated).toBe(true);

      const content = await manager.getRecords();
      expect(content).toContain('**复盘**: 低估了数据验证和回滚策略的工作量');
    });

    it('should update both actualTime and retrospective', async () => {
      const record: TaskRecord = {
        title: 'API 重构',
        type: 'refactoring',
        estimatedTime: '4小时',
        estimationBasis: '需要重构 10 个端点',
        date: '2024-03-17',
      };

      await manager.appendRecord(record);
      const updated = await manager.updateRecord('API 重构', {
        actualTime: '6小时',
        retrospective: '中间发现需要同步修改前端调用',
      });

      expect(updated).toBe(true);

      const content = await manager.getRecords();
      expect(content).toContain('**实际时间**: 6小时');
      expect(content).toContain('**复盘**: 中间发现需要同步修改前端调用');
    });

    it('should return false for non-existent record', async () => {
      const record: TaskRecord = {
        title: '存在的任务',
        type: 'chore',
        estimatedTime: '10分钟',
        estimationBasis: '简单修改',
      };

      await manager.appendRecord(record);
      const updated = await manager.updateRecord('不存在的任务', { actualTime: '5分钟' });

      expect(updated).toBe(false);
    });

    it('should add new fields if they did not exist in original record', async () => {
      const record: TaskRecord = {
        title: '简单任务',
        type: 'chore',
        estimatedTime: '10分钟',
        estimationBasis: '配置更新',
        date: '2024-03-18',
      };

      await manager.appendRecord(record);
      const updated = await manager.updateRecord('简单任务', {
        actualTime: '8分钟',
        retrospective: '比预期快',
      });

      expect(updated).toBe(true);

      const content = await manager.getRecords();
      expect(content).toContain('**实际时间**: 8分钟');
      expect(content).toContain('**复盘**: 比预期快');
    });
  });

  describe('getRecords', () => {
    it('should return default header when file is first created', async () => {
      const content = await manager.getRecords();

      expect(content).toContain('# 任务记录');
      expect(content).toContain('TaskRecordManager');
    });

    it('should return all records including header', async () => {
      await manager.appendRecord({
        title: '任务 A',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单修复',
      });

      const content = await manager.getRecords();
      expect(content).toContain('# 任务记录');
      expect(content).toContain('任务 A');
    });
  });

  describe('searchRecords', () => {
    it('should find records matching a query', async () => {
      await manager.appendRecord({
        title: '修复登录 Bug',
        type: 'bugfix',
        estimatedTime: '30分钟',
        estimationBasis: '表单验证问题',
        date: '2024-03-20',
      });

      await manager.appendRecord({
        title: '添加用户管理',
        type: 'feature-medium',
        estimatedTime: '2小时',
        estimationBasis: 'CRUD 功能',
        date: '2024-03-21',
      });

      const results = await manager.searchRecords('bugfix');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('修复登录 Bug');
      expect(results[0]).toContain('bugfix');
    });

    it('should return empty array when no matches found', async () => {
      await manager.appendRecord({
        title: '任务 A',
        type: 'chore',
        estimatedTime: '10分钟',
        estimationBasis: '简单',
      });

      const results = await manager.searchRecords('不存在的查询');
      expect(results).toEqual([]);
    });

    it('should perform case-insensitive search', async () => {
      await manager.appendRecord({
        title: '修复认证问题',
        type: 'bugfix',
        estimatedTime: '1小时',
        estimationBasis: 'JWT 相关',
      });

      const results = await manager.searchRecords('认证');
      expect(results.length).toBe(1);
    });

    it('should find multiple matching records', async () => {
      await manager.appendRecord({
        title: '修复 Bug A',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单',
      });

      await manager.appendRecord({
        title: '修复 Bug B',
        type: 'bugfix',
        estimatedTime: '30分钟',
        estimationBasis: '中等',
      });

      const results = await manager.searchRecords('Bug');
      expect(results.length).toBe(2);
    });
  });

  describe('parseRecords', () => {
    it('should parse records into structured data', async () => {
      await manager.appendRecord({
        title: '添加导出功能',
        type: 'feature-small',
        estimatedTime: '1小时',
        estimationBasis: '数据查询 + 格式转换',
        actualTime: '55分钟',
        retrospective: '估计较准确',
        date: '2024-03-09',
      });

      const records = await manager.parseRecords();
      expect(records.length).toBe(1);

      const [record] = records;
      expect(record.title).toBe('添加导出功能');
      expect(record.type).toBe('feature-small');
      expect(record.estimatedTime).toBe('1小时');
      expect(record.estimationBasis).toBe('数据查询 + 格式转换');
      expect(record.actualTime).toBe('55分钟');
      expect(record.retrospective).toBe('估计较准确');
      expect(record.date).toBe('2024-03-09');
    });

    it('should parse multiple records', async () => {
      await manager.appendRecord({
        title: '任务 A',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单',
        date: '2024-03-01',
      });

      await manager.appendRecord({
        title: '任务 B',
        type: 'feature-medium',
        estimatedTime: '3小时',
        estimationBasis: '复杂',
        date: '2024-03-02',
      });

      const records = await manager.parseRecords();
      expect(records.length).toBe(2);
      expect(records[0].title).toBe('任务 A');
      expect(records[1].title).toBe('任务 B');
    });

    it('should return empty array for records without standard format', async () => {
      // getRecords() creates the file with header, but no standard records
      const records = await manager.parseRecords();
      expect(records).toEqual([]);
    });

    it('should handle records with optional fields missing', async () => {
      await manager.appendRecord({
        title: '最小记录',
        type: 'chore',
        estimatedTime: '10分钟',
        estimationBasis: '简单',
        date: '2024-03-05',
      });

      const records = await manager.parseRecords();
      expect(records.length).toBe(1);
      expect(records[0].actualTime).toBeUndefined();
      expect(records[0].retrospective).toBeUndefined();
      expect(records[0].taskId).toBeUndefined();
    });

    it('should handle records with taskId', async () => {
      await manager.appendRecord({
        title: '关联任务',
        type: 'bugfix',
        estimatedTime: '20分钟',
        estimationBasis: '中等难度',
        taskId: 'issue-456',
        date: '2024-03-06',
      });

      const records = await manager.parseRecords();
      expect(records[0].taskId).toBe('issue-456');
    });
  });

  describe('resetInitialization', () => {
    it('should allow re-initialization after reset', async () => {
      await manager.getRecords();
      expect(manager.getRecordsFilePath()).toBeDefined();

      manager.resetInitialization();
      // Should be able to use again after reset
      const content = await manager.getRecords();
      expect(content).toContain('# 任务记录');
    });
  });
});
