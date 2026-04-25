/**
 * Tests for EtaRecorder.
 *
 * Issue #1234: Tests for task execution record management.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EtaRecorder, formatTaskRecord, type TaskRecordEntry } from './eta-recorder.js';

describe('formatTaskRecord', () => {
  it('should format a task record entry as Markdown', () => {
    const entry: TaskRecordEntry = {
      date: '2024-03-10',
      title: '重构登录模块',
      type: 'refactoring',
      estimatedTime: '30分钟',
      estimationBasis: '类似之前的表单重构，当时花了25分钟',
      actualTime: '45分钟',
      retrospective: '低估了密码验证逻辑的复杂度',
    };

    const result = formatTaskRecord(entry);

    expect(result).toContain('## 2024-03-10 重构登录模块');
    expect(result).toContain('**类型**: refactoring');
    expect(result).toContain('**估计时间**: 30分钟');
    expect(result).toContain('**估计依据**: 类似之前的表单重构');
    expect(result).toContain('**实际时间**: 45分钟');
    expect(result).toContain('**复盘**: 低估了密码验证逻辑的复杂度');
    expect(result).toContain('---');
  });

  it('should include all required fields', () => {
    const entry: TaskRecordEntry = {
      date: '2024-03-11',
      title: 'Test',
      type: 'bugfix',
      estimatedTime: '15分钟',
      estimationBasis: 'Simple fix',
      actualTime: '20分钟',
      retrospective: 'Slightly underestimated',
    };

    const result = formatTaskRecord(entry);

    const requiredFields = ['**类型**', '**估计时间**', '**估计依据**', '**实际时间**', '**复盘**'];
    for (const field of requiredFields) {
      expect(result).toContain(field);
    }
  });
});

describe('EtaRecorder', () => {
  let tmpDir: string;
  let recorder: EtaRecorder;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eta-test-'));
    recorder = new EtaRecorder(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('paths', () => {
    it('should return correct task records path', () => {
      expect(recorder.getTaskRecordsPath()).toBe(
        path.join(tmpDir, '.claude', 'task-records.md'),
      );
    });

    it('should return correct ETA rules path', () => {
      expect(recorder.getEtaRulesPath()).toBe(
        path.join(tmpDir, '.claude', 'eta-rules.md'),
      );
    });
  });

  describe('initialization', () => {
    it('should create .claude directory on ensureClaudeDir', async () => {
      await recorder.ensureClaudeDir();
      const stat = await fs.stat(path.join(tmpDir, '.claude'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should initialize task records file with header', async () => {
      await recorder.initializeTaskRecords();

      const content = await fs.readFile(recorder.getTaskRecordsPath(), 'utf-8');
      expect(content).toContain('# 任务记录');
      expect(content).toContain('ETA 预估系统');
    });

    it('should not overwrite existing task records file', async () => {
      await recorder.initializeTaskRecords();
      await fs.appendFile(recorder.getTaskRecordsPath(), '## existing data', 'utf-8');

      await recorder.initializeTaskRecords();

      const content = await fs.readFile(recorder.getTaskRecordsPath(), 'utf-8');
      expect(content).toContain('existing data');
    });

    it('should initialize ETA rules file with template', async () => {
      await recorder.initializeEtaRules();

      const content = await fs.readFile(recorder.getEtaRulesPath(), 'utf-8');
      expect(content).toContain('# ETA 估计规则');
      expect(content).toContain('任务类型基准时间');
      expect(content).toContain('经验规则');
    });

    it('should not overwrite existing ETA rules file', async () => {
      await recorder.initializeEtaRules();
      await fs.appendFile(recorder.getEtaRulesPath(), '## custom rule', 'utf-8');

      await recorder.initializeEtaRules();

      const content = await fs.readFile(recorder.getEtaRulesPath(), 'utf-8');
      expect(content).toContain('custom rule');
    });
  });

  describe('reading', () => {
    it('should return null when task records file does not exist', async () => {
      const result = await recorder.readTaskRecords();
      expect(result).toBeNull();
    });

    it('should return null when ETA rules file does not exist', async () => {
      const result = await recorder.readEtaRules();
      expect(result).toBeNull();
    });

    it('should read task records content', async () => {
      await recorder.initializeTaskRecords();
      const content = await recorder.readTaskRecords();
      expect(content).not.toBeNull();
      expect(content).toContain('# 任务记录');
    });

    it('should read ETA rules content', async () => {
      await recorder.initializeEtaRules();
      const content = await recorder.readEtaRules();
      expect(content).not.toBeNull();
      expect(content).toContain('# ETA 估计规则');
    });

    it('should detect existing task records', async () => {
      expect(await recorder.hasTaskRecords()).toBe(false);
      await recorder.initializeTaskRecords();
      expect(await recorder.hasTaskRecords()).toBe(true);
    });

    it('should detect existing ETA rules', async () => {
      expect(await recorder.hasEtaRules()).toBe(false);
      await recorder.initializeEtaRules();
      expect(await recorder.hasEtaRules()).toBe(true);
    });
  });

  describe('appending records', () => {
    it('should append a task record entry', async () => {
      const entry: TaskRecordEntry = {
        date: '2024-03-10',
        title: '重构登录模块',
        type: 'refactoring',
        estimatedTime: '30分钟',
        estimationBasis: '类似之前的表单重构',
        actualTime: '45分钟',
        retrospective: '低估了复杂度',
      };

      await recorder.appendTaskRecord(entry);

      const content = await fs.readFile(recorder.getTaskRecordsPath(), 'utf-8');
      expect(content).toContain('## 2024-03-10 重构登录模块');
      expect(content).toContain('**类型**: refactoring');
      expect(content).toContain('**估计时间**: 30分钟');
      expect(content).toContain('**实际时间**: 45分钟');
    });

    it('should auto-initialize when appending to non-existent file', async () => {
      const entry: TaskRecordEntry = {
        date: '2024-03-10',
        title: 'Test',
        type: 'bugfix',
        estimatedTime: '10分钟',
        estimationBasis: 'test',
        actualTime: '12分钟',
        retrospective: 'ok',
      };

      await recorder.appendTaskRecord(entry);

      const content = await fs.readFile(recorder.getTaskRecordsPath(), 'utf-8');
      expect(content).toContain('# 任务记录');
      expect(content).toContain('## 2024-03-10 Test');
    });

    it('should append multiple records in order', async () => {
      const entries: TaskRecordEntry[] = [
        {
          date: '2024-03-10',
          title: 'Task A',
          type: 'feature',
          estimatedTime: '30分钟',
          estimationBasis: 'test',
          actualTime: '25分钟',
          retrospective: 'ok',
        },
        {
          date: '2024-03-11',
          title: 'Task B',
          type: 'bugfix',
          estimatedTime: '15分钟',
          estimationBasis: 'test',
          actualTime: '20分钟',
          retrospective: 'underestimated',
        },
      ];

      for (const entry of entries) {
        await recorder.appendTaskRecord(entry);
      }

      const content = await fs.readFile(recorder.getTaskRecordsPath(), 'utf-8');
      const firstIndex = content.indexOf('Task A');
      const secondIndex = content.indexOf('Task B');
      expect(firstIndex).toBeLessThan(secondIndex);
    });
  });

  describe('getRecentRecords', () => {
    it('should return null when no records exist', async () => {
      const result = await recorder.getRecentRecords();
      expect(result).toBeNull();
    });

    it('should return recent records', async () => {
      const entries: TaskRecordEntry[] = [
        {
          date: '2024-03-08',
          title: 'Task 1',
          type: 'feature',
          estimatedTime: '30分钟',
          estimationBasis: 'test',
          actualTime: '25分钟',
          retrospective: 'ok',
        },
        {
          date: '2024-03-09',
          title: 'Task 2',
          type: 'bugfix',
          estimatedTime: '15分钟',
          estimationBasis: 'test',
          actualTime: '20分钟',
          retrospective: 'under',
        },
        {
          date: '2024-03-10',
          title: 'Task 3',
          type: 'refactoring',
          estimatedTime: '1小时',
          estimationBasis: 'test',
          actualTime: '55分钟',
          retrospective: 'good',
        },
      ];

      for (const entry of entries) {
        await recorder.appendTaskRecord(entry);
      }

      // Get last 2 records
      const result = await recorder.getRecentRecords(2);
      expect(result).not.toBeNull();
      expect(result).toContain('Task 2');
      expect(result).toContain('Task 3');
      expect(result).not.toContain('Task 1');
    });
  });
});
