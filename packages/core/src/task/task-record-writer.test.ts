/**
 * Tests for TaskRecordWriter.
 *
 * Issue #1234 Phase 1: Markdown task record writer.
 * Verifies appending, reading, and searching of free-form Markdown task records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordWriter, formatDuration, formatRecord } from './task-record-writer.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-writer-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('formatDuration', () => {
  it('should format seconds', () => {
    expect(formatDuration(30_000)).toBe('30秒');
  });

  it('should format minutes', () => {
    expect(formatDuration(5 * 60 * 1000)).toBe('5分钟');
  });

  it('should format hours', () => {
    expect(formatDuration(2 * 60 * 60 * 1000)).toBe('2小时');
  });

  it('should format hours and minutes', () => {
    expect(formatDuration(90 * 60 * 1000)).toBe('1小时30分钟');
  });

  it('should round to nearest minute', () => {
    expect(formatDuration(90_000)).toBe('2分钟');
  });
});

describe('formatRecord', () => {
  it('should format a complete record', () => {
    const record = formatRecord({
      title: 'Fix login bug',
      type: 'bugfix',
      estimatedTime: '30分钟',
      estimationBasis: 'Similar to previous form validation fix',
      actualTime: '45分钟',
      review: 'Underestimated the password validation complexity',
    });

    expect(record).toContain('## ');
    expect(record).toContain('Fix login bug');
    expect(record).toContain('**类型**: bugfix');
    expect(record).toContain('**估计时间**: 30分钟');
    expect(record).toContain('**估计依据**: Similar to previous form validation fix');
    expect(record).toContain('**实际时间**: 45分钟');
    expect(record).toContain('**复盘**: Underestimated the password validation complexity');
  });

  it('should format a minimal record', () => {
    const record = formatRecord({
      title: 'Quick fix',
      type: 'chore',
    });

    expect(record).toContain('Quick fix');
    expect(record).toContain('**类型**: chore');
    expect(record).toContain('**估计时间**: 未估计');
    expect(record).toContain('**实际时间**: 未记录');
    expect(record).not.toContain('**估计依据**');
    expect(record).not.toContain('**复盘**');
  });
});

describe('TaskRecordWriter', () => {
  let writer: TaskRecordWriter;

  beforeEach(() => {
    writer = new TaskRecordWriter(tempDir);
  });

  describe('getRecordsPath', () => {
    it('should return path under .claude/task-records.md', () => {
      const result = writer.getRecordsPath();
      expect(result).toContain('.claude');
      expect(result).toContain('task-records.md');
    });
  });

  describe('appendRecord', () => {
    it('should create file with header on first write', async () => {
      await writer.appendRecord({
        title: 'First task',
        type: 'feature',
        actualTime: '10分钟',
      });

      const content = await fs.readFile(writer.getRecordsPath(), 'utf-8');
      expect(content).toContain('# Task Records');
      expect(content).toContain('First task');
    });

    it('should append second record', async () => {
      await writer.appendRecord({ title: 'Task A', type: 'bugfix' });
      await writer.appendRecord({ title: 'Task B', type: 'feature' });

      const content = await fs.readFile(writer.getRecordsPath(), 'utf-8');
      expect(content).toContain('Task A');
      expect(content).toContain('Task B');
      // Header should only appear once
      expect(content.indexOf('# Task Records')).toBe(content.lastIndexOf('# Task Records'));
    });

    it('should create .claude directory if needed', async () => {
      await writer.appendRecord({ title: 'Test', type: 'chore' });

      const claudeDir = path.join(tempDir, '.claude');
      const stat = await fs.stat(claudeDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('readRecords', () => {
    it('should return empty string when file does not exist', async () => {
      const result = await writer.readRecords();
      expect(result).toBe('');
    });

    it('should return file content', async () => {
      await writer.appendRecord({ title: 'Read test', type: 'test' });

      const result = await writer.readRecords();
      expect(result).toContain('Read test');
    });
  });

  describe('searchRecords', () => {
    it('should return empty array when no records', async () => {
      const result = await writer.searchRecords('anything');
      expect(result).toEqual([]);
    });

    it('should find matching records', async () => {
      await writer.appendRecord({ title: 'Fix login bug', type: 'bugfix' });
      await writer.appendRecord({ title: 'Add export feature', type: 'feature' });

      const results = await writer.searchRecords('login');
      expect(results).toHaveLength(1);
      expect(results[0]).toContain('Fix login bug');
    });

    it('should be case-insensitive', async () => {
      await writer.appendRecord({ title: 'Fix Login Bug', type: 'bugfix' });

      const results = await writer.searchRecords('login');
      expect(results).toHaveLength(1);
    });

    it('should return multiple matches', async () => {
      await writer.appendRecord({ title: 'Fix login bug', type: 'bugfix' });
      await writer.appendRecord({ title: 'Login redesign', type: 'feature' });
      await writer.appendRecord({ title: 'Export CSV', type: 'feature' });

      const results = await writer.searchRecords('login');
      expect(results).toHaveLength(2);
    });
  });
});
