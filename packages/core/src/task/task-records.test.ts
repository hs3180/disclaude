/**
 * Tests for TaskRecordKeeper.
 *
 * Verifies Markdown-based task record storage and retrieval.
 *
 * @see Issue #1234 - Phase 1: Task Record Format
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordKeeper } from './task-records.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-records-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskRecordKeeper', () => {
  let keeper: TaskRecordKeeper;

  beforeEach(() => {
    keeper = new TaskRecordKeeper(tempDir);
  });

  describe('constructor', () => {
    it('should create keeper with workspace directory', () => {
      expect(keeper).toBeInstanceOf(TaskRecordKeeper);
    });

    it('should return correct records path', () => {
      expect(keeper.getRecordsPath()).toBe(path.join(tempDir, '.claude', 'task-records.md'));
    });

    it('should return correct eta-rules path', () => {
      expect(keeper.getEtaRulesPath()).toBe(path.join(tempDir, '.claude', 'eta-rules.md'));
    });
  });

  describe('initialize', () => {
    it('should create .claude directory and records file', async () => {
      await keeper.initialize();

      const content = await fs.readFile(keeper.getRecordsPath(), 'utf-8');
      expect(content).toContain('# Task Records');
      expect(content).toContain('Issue #1234');
    });

    it('should not overwrite existing records file', async () => {
      await keeper.initialize();

      // Append some data
      await fs.appendFile(keeper.getRecordsPath(), '## Existing Record\n', 'utf-8');

      // Initialize again
      await keeper.initialize();

      const content = await fs.readFile(keeper.getRecordsPath(), 'utf-8');
      expect(content).toContain('Existing Record');
    });
  });

  describe('initializeEtaRules', () => {
    it('should create eta-rules.md template', async () => {
      await keeper.initializeEtaRules();

      const content = await fs.readFile(keeper.getEtaRulesPath(), 'utf-8');
      expect(content).toContain('# ETA 估计规则');
      expect(content).toContain('任务类型基准时间');
      expect(content).toContain('bugfix');
    });

    it('should not overwrite existing eta-rules file', async () => {
      await keeper.initializeEtaRules();
      await fs.appendFile(keeper.getEtaRulesPath(), '## Custom Rule\n', 'utf-8');

      await keeper.initializeEtaRules();

      const content = await fs.readFile(keeper.getEtaRulesPath(), 'utf-8');
      expect(content).toContain('Custom Rule');
    });
  });

  describe('appendRecord', () => {
    it('should append a basic task record', async () => {
      await keeper.appendRecord({
        title: 'Refactor Login Module',
        type: 'refactoring',
        actualTime: '45分钟',
        review: '低估了密码验证逻辑的复杂度',
      });

      const content = await fs.readFile(keeper.getRecordsPath(), 'utf-8');
      expect(content).toContain('## ');
      expect(content).toContain('Refactor Login Module');
      expect(content).toContain('**类型**: refactoring');
      expect(content).toContain('**实际时间**: 45分钟');
      expect(content).toContain('**复盘**: 低估了密码验证逻辑的复杂度');
    });

    it('should append a complete record with all fields', async () => {
      await keeper.appendRecord({
        title: 'Add User Export Feature',
        type: 'feature',
        estimatedTime: '1小时',
        estimationReasoning: '需要数据查询 + 格式转换 + 文件下载，参照之前的报表功能',
        actualTime: '55分钟',
        review: '估计较准确',
        taskId: 'msg-123',
        notes: '使用了现有模板',
      });

      const content = await fs.readFile(keeper.getRecordsPath(), 'utf-8');
      expect(content).toContain('Add User Export Feature');
      expect(content).toContain('**估计时间**: 1小时');
      expect(content).toContain('**估计依据**');
      expect(content).toContain('**实际时间**: 55分钟');
      expect(content).toContain('**Task ID**: msg-123');
      expect(content).toContain('**备注**: 使用了现有模板');
    });

    it('should auto-initialize file on first append', async () => {
      // No initialize() call - should auto-create
      await keeper.appendRecord({
        title: 'First Task',
        type: 'bugfix',
        actualTime: '20分钟',
      });

      const content = await fs.readFile(keeper.getRecordsPath(), 'utf-8');
      expect(content).toContain('# Task Records');
      expect(content).toContain('First Task');
    });

    it('should append multiple records in order', async () => {
      await keeper.appendRecord({ title: 'Task A', type: 'bugfix', actualTime: '10分钟' });
      await keeper.appendRecord({ title: 'Task B', type: 'feature', actualTime: '30分钟' });
      await keeper.appendRecord({ title: 'Task C', type: 'refactoring', actualTime: '1小时' });

      const content = await fs.readFile(keeper.getRecordsPath(), 'utf-8');
      const taskAIndex = content.indexOf('Task A');
      const taskBIndex = content.indexOf('Task B');
      const taskCIndex = content.indexOf('Task C');
      expect(taskAIndex).toBeLessThan(taskBIndex);
      expect(taskBIndex).toBeLessThan(taskCIndex);
    });
  });

  describe('appendRecordSync', () => {
    it('should append a record synchronously', () => {
      keeper.appendRecordSync({
        title: 'Sync Task',
        type: 'bugfix',
        actualTime: '5分钟',
      });

      const content = syncFs.readFileSync(keeper.getRecordsPath(), 'utf-8');
      expect(content).toContain('Sync Task');
      expect(content).toContain('**实际时间**: 5分钟');
    });
  });

  describe('readRecords', () => {
    it('should return empty array when file does not exist', async () => {
      const records = await keeper.readRecords();
      expect(records).toEqual([]);
    });

    it('should parse records from file', async () => {
      await keeper.appendRecord({ title: 'Task A', type: 'bugfix', actualTime: '10分钟' });
      await keeper.appendRecord({ title: 'Task B', type: 'feature', actualTime: '30分钟' });

      const records = await keeper.readRecords();
      expect(records).toHaveLength(2);
      expect(records[0].title).toBe('Task A');
      expect(records[0].fields['类型']).toBe('bugfix');
      expect(records[1].title).toBe('Task B');
    });

    it('should include date in parsed records', async () => {
      await keeper.appendRecord({ title: 'Task X', type: 'feature', actualTime: '20分钟' });

      const records = await keeper.readRecords();
      expect(records[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should parse all fields correctly', async () => {
      await keeper.appendRecord({
        title: 'Full Record Task',
        taskId: 'msg-456',
        type: 'feature',
        estimatedTime: '2小时',
        estimationReasoning: '参考之前类似任务',
        actualTime: '1.5小时',
        review: '比预期快',
        notes: '有参考代码',
      });

      const records = await keeper.readRecords();
      expect(records).toHaveLength(1);
      expect(records[0].fields).toEqual({
        'Task ID': 'msg-456',
        '类型': 'feature',
        '估计时间': '2小时',
        '估计依据': '参考之前类似任务',
        '实际时间': '1.5小时',
        '复盘': '比预期快',
        '备注': '有参考代码',
      });
    });
  });

  describe('searchRecords', () => {
    beforeEach(async () => {
      await keeper.appendRecord({ title: 'Login Bug Fix', type: 'bugfix', actualTime: '10分钟' });
      await keeper.appendRecord({ title: 'Export Feature', type: 'feature', actualTime: '30分钟' });
      await keeper.appendRecord({ title: 'Auth Refactor', type: 'refactoring', actualTime: '1小时' });
    });

    it('should filter by type', async () => {
      const results = await keeper.searchRecords({ type: 'bugfix' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Login Bug Fix');
    });

    it('should filter by type (case-insensitive)', async () => {
      const results = await keeper.searchRecords({ type: 'Feature' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Export Feature');
    });

    it('should full-text search in title', async () => {
      const results = await keeper.searchRecords({ query: 'Auth' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Auth Refactor');
    });

    it('should full-text search in content', async () => {
      const results = await keeper.searchRecords({ query: '30分钟' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Export Feature');
    });

    it('should limit results', async () => {
      const results = await keeper.searchRecords({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('should combine filters', async () => {
      const results = await keeper.searchRecords({ type: 'feature', query: 'Export' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Export Feature');
    });

    it('should return empty when no matches', async () => {
      const results = await keeper.searchRecords({ query: 'nonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('parseRecords', () => {
    it('should handle empty content', () => {
      const records = keeper.parseRecords('');
      expect(records).toEqual([]);
    });

    it('should handle header-only content', () => {
      const content = '# Task Records\n\n> Some intro\n\n---\n';
      const records = keeper.parseRecords(content);
      expect(records).toEqual([]);
    });

    it('should parse records with no fields', () => {
      const content = '## 2024-03-10 Minimal Task\n\nJust a simple record.\n\n---\n';
      const records = keeper.parseRecords(content);
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Minimal Task');
      expect(records[0].date).toBe('2024-03-10');
    });

    it('should handle special characters in field values', () => {
      const content = `## 2024-03-10 Special Chars

- **复盘**: 包含 <html> 标签和 "引号" 以及 & 符号

---

`;
      const records = keeper.parseRecords(content);
      expect(records).toHaveLength(1);
      expect(records[0].fields['复盘']).toContain('<html>');
      expect(records[0].fields['复盘']).toContain('"引号"');
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      expect(await keeper.exists()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await keeper.initialize();
      expect(await keeper.exists()).toBe(true);
    });
  });

  describe('round-trip', () => {
    it('should preserve data through write-read cycle', async () => {
      const original = {
        title: 'Round Trip Test',
        taskId: 'rt-001',
        type: 'feature',
        estimatedTime: '30分钟',
        estimationReasoning: '基于之前的经验',
        actualTime: '25分钟',
        review: '估计较为准确',
      };

      await keeper.appendRecord(original);
      const records = await keeper.readRecords();

      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Round Trip Test');
      expect(records[0].fields['Task ID']).toBe('rt-001');
      expect(records[0].fields['类型']).toBe('feature');
      expect(records[0].fields['估计时间']).toBe('30分钟');
      expect(records[0].fields['实际时间']).toBe('25分钟');
    });
  });
});
