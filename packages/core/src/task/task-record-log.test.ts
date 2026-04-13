/**
 * Tests for TaskRecordLog.
 *
 * Verifies non-structured Markdown task record storage.
 *
 * Issue #1234: Phase 1 — Task ETA record system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getTaskRecordsPath,
  appendTaskRecord,
  readTaskRecords,
  searchTaskRecords,
} from './task-record-log.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-log-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskRecordLog', () => {
  describe('getTaskRecordsPath', () => {
    it('should return path under .claude directory', () => {
      const result = getTaskRecordsPath('/workspace');
      expect(result).toBe(path.join('/workspace', '.claude', 'task-records.md'));
    });
  });

  describe('appendTaskRecord', () => {
    it('should create .claude directory and task-records.md if not exists', async () => {
      await appendTaskRecord(tempDir, '重构登录模块', [
        '- **类型**: refactoring',
        '- **估计时间**: 30分钟',
        '- **实际时间**: 45分钟',
        '- **复盘**: 低估了密码验证逻辑的复杂度',
      ].join('\n'));

      const filePath = getTaskRecordsPath(tempDir);
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it('should write file header on first write', async () => {
      await appendTaskRecord(tempDir, 'Test task', '- **类型**: feature');

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('# 任务记录');
    });

    it('should append task record with date-prefixed heading', async () => {
      await appendTaskRecord(tempDir, '重构登录模块', [
        '- **类型**: refactoring',
        '- **估计时间**: 30分钟',
        '- **估计依据**: 类似之前的表单重构',
        '- **实际时间**: 45分钟',
        '- **复盘**: 低估了复杂度',
      ].join('\n'));

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('## ');
      expect(content).toContain('重构登录模块');
      expect(content).toContain('**类型**: refactoring');
      expect(content).toContain('**估计时间**: 30分钟');
      expect(content).toContain('**估计依据**: 类似之前的表单重构');
      expect(content).toContain('**实际时间**: 45分钟');
      expect(content).toContain('**复盘**: 低估了复杂度');
    });

    it('should append multiple records preserving order', async () => {
      await appendTaskRecord(tempDir, '第一个任务', '- **类型**: bugfix\n- **实际时间**: 20分钟');
      await appendTaskRecord(tempDir, '第二个任务', '- **类型**: feature\n- **实际时间**: 1小时');

      const content = await readTaskRecords(tempDir);
      const firstIndex = content.indexOf('第一个任务');
      const secondIndex = content.indexOf('第二个任务');
      expect(firstIndex).toBeGreaterThan(-1);
      expect(secondIndex).toBeGreaterThan(-1);
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it('should not overwrite existing records on subsequent appends', async () => {
      await appendTaskRecord(tempDir, '任务A', '- **实际时间**: 10分钟');
      await appendTaskRecord(tempDir, '任务B', '- **实际时间**: 20分钟');

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('任务A');
      expect(content).toContain('任务B');
    });

    it('should handle free-form Markdown body', async () => {
      const body = `这个任务比预期复杂。

涉及多个模块：
- 模块A: 简单修改
- 模块B: 需要重写

\`\`\`typescript
const result = complexLogic();
\`\`\`

**结论**: 下次遇到类似任务应预留更多时间。`;

      await appendTaskRecord(tempDir, '复杂重构任务', body);

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('模块A');
      expect(content).toContain('complexLogic()');
      expect(content).toContain('结论');
    });
  });

  describe('readTaskRecords', () => {
    it('should return empty string when file does not exist', async () => {
      const result = await readTaskRecords(tempDir);
      expect(result).toBe('');
    });

    it('should return full file content', async () => {
      await appendTaskRecord(tempDir, 'Test', '- body content');

      const result = await readTaskRecords(tempDir);
      expect(result).toContain('# 任务记录');
      expect(result).toContain('Test');
      expect(result).toContain('body content');
    });
  });

  describe('searchTaskRecords', () => {
    it('should return empty array when file does not exist', async () => {
      const results = await searchTaskRecords(tempDir, 'keyword');
      expect(results).toEqual([]);
    });

    it('should find matching sections by keyword', async () => {
      await appendTaskRecord(tempDir, '重构登录模块', '- **类型**: refactoring\n- **实际时间**: 45分钟');
      await appendTaskRecord(tempDir, '添加导出功能', '- **类型**: feature\n- **实际时间**: 55分钟');
      await appendTaskRecord(tempDir, '修复登录Bug', '- **类型**: bugfix\n- **实际时间**: 20分钟');

      const results = await searchTaskRecords(tempDir, '登录');
      expect(results.length).toBe(2);
      // Should find "重构登录模块" and "修复登录Bug" sections
      const combined = results.join('\n');
      expect(combined).toContain('重构登录模块');
      expect(combined).toContain('修复登录Bug');
      expect(combined).not.toContain('添加导出功能');
    });

    it('should be case-insensitive', async () => {
      await appendTaskRecord(tempDir, 'Refactor Login', '- **type**: refactoring');

      const results = await searchTaskRecords(tempDir, 'login');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('Refactor Login');
    });

    it('should match keywords in body content', async () => {
      await appendTaskRecord(tempDir, 'Task A', '- low complexity');
      await appendTaskRecord(tempDir, 'Task B', '- 复盘: 涉及异步逻辑，低估了复杂度');

      const results = await searchTaskRecords(tempDir, '异步逻辑');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('Task B');
    });

    it('should return full section content for matches', async () => {
      await appendTaskRecord(tempDir, 'Target task', '- **类型**: feature\n- **估计时间**: 1小时\n- **实际时间**: 55分钟');

      const results = await searchTaskRecords(tempDir, 'Target');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('Target task');
      expect(results[0]).toContain('feature');
      expect(results[0]).toContain('1小时');
      expect(results[0]).toContain('55分钟');
    });

    it('should handle no matches gracefully', async () => {
      await appendTaskRecord(tempDir, 'Some task', '- some content');

      const results = await searchTaskRecords(tempDir, 'nonexistent_keyword_xyz');
      expect(results).toEqual([]);
    });
  });
});
