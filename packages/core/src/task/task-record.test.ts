/**
 * Tests for TaskRecordManager (Issue #1234 Phase 1).
 *
 * Verifies Markdown task record persistence, search, and parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordManager } from './task-record.js';

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

    it('should return correct records path', () => {
      expect(manager.getRecordsPath()).toContain('.claude');
      expect(manager.getRecordsPath()).toContain('task-records.md');
    });
  });

  describe('ensureInitialized', () => {
    it('should create .claude directory and task-records.md', async () => {
      await manager.ensureInitialized();

      const claudeDir = path.join(tempDir, '.claude');
      const stat = await fs.stat(claudeDir);
      expect(stat.isDirectory()).toBe(true);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('任务记录');
    });

    it('should not overwrite existing file', async () => {
      await manager.ensureInitialized();
      const content1 = await fs.readFile(manager.getRecordsPath(), 'utf-8');

      // Add some content
      await fs.appendFile(manager.getRecordsPath(), '## test data\n', 'utf-8');

      await manager.ensureInitialized();
      const content2 = await fs.readFile(manager.getRecordsPath(), 'utf-8');

      expect(content2).toContain('test data');
      expect(content2.length).toBeGreaterThan(content1.length);
    });

    it('should handle existing directory', async () => {
      await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await manager.ensureInitialized();

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('任务记录');
    });
  });

  describe('appendRecord', () => {
    it('should append a new task record', async () => {
      await manager.appendRecord({
        title: '重构登录模块',
        type: 'refactoring',
        estimatedTime: '30分钟',
        estimationBasis: '类似之前的表单重构，当时花了25分钟',
        actualTime: '45分钟',
        retrospective: '低估了密码验证逻辑的复杂度，下次遇到类似模块应预留更多时间',
      });

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('重构登录模块');
      expect(content).toContain('refactoring');
      expect(content).toContain('30分钟');
      expect(content).toContain('45分钟');
      expect(content).toContain('估计依据');
      expect(content).toContain('复盘');
    });

    it('should use current date when not provided', async () => {
      await manager.appendRecord({
        title: '测试任务',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询',
        actualTime: '55分钟',
        retrospective: '估计较准确',
      });

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      const [today] = new Date().toISOString().split('T');
      expect(content).toContain(today);
    });

    it('should use provided date', async () => {
      await manager.appendRecord({
        title: '历史任务',
        date: '2024-03-09',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '参照之前的报表功能',
        actualTime: '55分钟',
        retrospective: '估计较准确',
      });

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('2024-03-09');
      expect(content).toContain('历史任务');
    });

    it('should append multiple records', async () => {
      await manager.appendRecord({
        title: '任务A',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单修复',
        actualTime: '10分钟',
        retrospective: '顺利',
      });

      await manager.appendRecord({
        title: '任务B',
        type: 'feature',
        estimatedTime: '2小时',
        estimationBasis: '需要多个组件',
        actualTime: '3小时',
        retrospective: '低估了复杂度',
      });

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('任务A');
      expect(content).toContain('任务B');
      expect(content).toContain('bugfix');
      expect(content).toContain('feature');
    });
  });

  describe('readRecords', () => {
    it('should return file content', async () => {
      await manager.appendRecord({
        title: '读取测试',
        type: 'test',
        estimatedTime: '5分钟',
        estimationBasis: '简单测试',
        actualTime: '5分钟',
        retrospective: '准确',
      });

      const content = await manager.readRecords();
      expect(content).toContain('读取测试');
    });

    it('should throw when file does not exist', async () => {
      await expect(manager.readRecords()).rejects.toThrow();
    });
  });

  describe('searchRecords', () => {
    beforeEach(async () => {
      await manager.appendRecord({
        title: '重构登录模块',
        date: '2024-03-10',
        type: 'refactoring',
        estimatedTime: '30分钟',
        estimationBasis: '类似之前的表单重构',
        actualTime: '45分钟',
        retrospective: '低估了密码验证逻辑的复杂度',
      });

      await manager.appendRecord({
        title: '添加用户导出功能',
        date: '2024-03-09',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询+格式转换+文件下载',
        actualTime: '55分钟',
        retrospective: '估计较准确',
      });

      await manager.appendRecord({
        title: '修复认证Bug',
        date: '2024-03-11',
        type: 'bugfix',
        estimatedTime: '20分钟',
        estimationBasis: '简单的Token过期处理',
        actualTime: '35分钟',
        retrospective: '需要考虑更多边界情况',
      });
    });

    it('should find records by title keyword', async () => {
      const results = await manager.searchRecords('登录');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('重构登录模块');
    });

    it('should find records by content keyword', async () => {
      const results = await manager.searchRecords('密码验证');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('低估了密码验证逻辑的复杂度');
    });

    it('should find multiple matching records', async () => {
      const results = await manager.searchRecords('2024-03');
      expect(results.length).toBe(3);
    });

    it('should return empty for no matches', async () => {
      const results = await manager.searchRecords('不存在的关键词xyz');
      expect(results.length).toBe(0);
    });

    it('should be case-insensitive', async () => {
      const results = await manager.searchRecords('BUGFIX');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('修复认证Bug');
    });
  });

  describe('parseRecords', () => {
    beforeEach(async () => {
      await manager.appendRecord({
        title: '重构登录模块',
        date: '2024-03-10',
        type: 'refactoring',
        estimatedTime: '30分钟',
        estimationBasis: '类似之前的表单重构，当时花了25分钟',
        actualTime: '45分钟',
        retrospective: '低估了密码验证逻辑的复杂度',
      });

      await manager.appendRecord({
        title: '添加用户导出功能',
        date: '2024-03-09',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询+格式转换+文件下载',
        actualTime: '55分钟',
        retrospective: '估计较准确',
      });
    });

    it('should parse all records', async () => {
      const records = await manager.parseRecords();
      expect(records.length).toBe(2);
    });

    it('should parse record fields correctly', async () => {
      const records = await manager.parseRecords();
      const loginRecord = records.find(r => r.title.includes('重构登录'));

      expect(loginRecord).toBeDefined();
      expect(loginRecord!.date).toBe('2024-03-10');
      expect(loginRecord!.type).toBe('refactoring');
      expect(loginRecord!.estimatedTime).toBe('30分钟');
      expect(loginRecord!.actualTime).toBe('45分钟');
      expect(loginRecord!.retrospective).toContain('低估了密码验证逻辑');
    });

    it('should parse multiple records with correct fields', async () => {
      const records = await manager.parseRecords();
      const exportRecord = records.find(r => r.title.includes('添加用户导出'));

      expect(exportRecord).toBeDefined();
      expect(exportRecord!.date).toBe('2024-03-09');
      expect(exportRecord!.type).toBe('feature');
      expect(exportRecord!.estimatedTime).toBe('1小时');
      expect(exportRecord!.actualTime).toBe('55分钟');
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      expect(await manager.exists()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await manager.ensureInitialized();
      expect(await manager.exists()).toBe(true);
    });

    it('should return true after appending record', async () => {
      await manager.appendRecord({
        title: '测试',
        type: 'test',
        estimatedTime: '5分钟',
        estimationBasis: '测试',
        actualTime: '5分钟',
        retrospective: '测试',
      });
      expect(await manager.exists()).toBe(true);
    });
  });
});
