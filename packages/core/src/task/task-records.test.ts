/**
 * Tests for TaskRecords — Markdown-based task execution record system.
 *
 * Verifies non-structured Markdown task record storage per Issue #1234 Phase 1.
 *
 * Key principles tested:
 * - Records stored as Markdown, NOT structured data
 * - Each record includes: type, estimated time, estimation basis, actual time, review
 * - Records are human-readable and append-only
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecords, type TaskRecordEntry } from './task-records.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-records-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskRecords', () => {
  let records: TaskRecords;

  beforeEach(() => {
    records = new TaskRecords({ baseDir: tempDir });
  });

  const sampleEntry: TaskRecordEntry = {
    title: '重构登录模块',
    type: 'refactoring',
    estimatedTime: '30分钟',
    estimationBasis: '类似之前的表单重构，当时花了25分钟',
    actualTime: '45分钟',
    review: '低估了密码验证逻辑的复杂度，下次遇到类似模块应预留更多时间',
  };

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const r = new TaskRecords({ baseDir: tempDir });
      expect(r.getFilePath()).toContain('.claude');
      expect(r.getFilePath()).toContain('task-records.md');
    });

    it('should use custom subDir and fileName', () => {
      const r = new TaskRecords({
        baseDir: tempDir,
        subDir: '.custom',
        fileName: 'my-records.md',
      });
      expect(r.getFilePath()).toContain('.custom');
      expect(r.getFilePath()).toContain('my-records.md');
    });
  });

  describe('ensureFile', () => {
    it('should create records file with header if not exists', async () => {
      await records.ensureFile();

      const content = await fs.readFile(records.getFilePath(), 'utf-8');
      expect(content).toContain('# 任务记录');
    });

    it('should not overwrite existing file', async () => {
      await records.ensureFile();
      await records.append(sampleEntry);

      const contentBefore = await fs.readFile(records.getFilePath(), 'utf-8');
      await records.ensureFile();
      const contentAfter = await fs.readFile(records.getFilePath(), 'utf-8');

      expect(contentBefore).toBe(contentAfter);
    });

    it('should create subdirectory if needed', async () => {
      const r = new TaskRecords({ baseDir: tempDir, subDir: 'deep/nested/dir' });
      await r.ensureFile();

      const stat = await fs.stat(path.join(tempDir, 'deep', 'nested', 'dir'));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('append', () => {
    it('should append a task record in Markdown format', async () => {
      await records.append(sampleEntry);

      const content = await fs.readFile(records.getFilePath(), 'utf-8');
      expect(content).toContain('# 任务记录');
      expect(content).toContain('## ');
      expect(content).toContain('重构登录模块');
      expect(content).toContain('- **类型**: refactoring');
      expect(content).toContain('- **估计时间**: 30分钟');
      expect(content).toContain('- **估计依据**: 类似之前的表单重构');
      expect(content).toContain('- **实际时间**: 45分钟');
      expect(content).toContain('- **复盘**: 低估了密码验证逻辑');
    });

    it('should include date in heading', async () => {
      await records.append(sampleEntry);

      const content = await fs.readFile(records.getFilePath(), 'utf-8');
      const [today] = new Date().toISOString().split('T');
      expect(content).toContain(`## ${today}`);
    });

    it('should include hidden timestamp for sorting', async () => {
      await records.append(sampleEntry);

      const content = await fs.readFile(records.getFilePath(), 'utf-8');
      expect(content).toMatch(/<!-- timestamp: \d{4}-\d{2}-\d{2}T/);
    });

    it('should append multiple records', async () => {
      await records.append(sampleEntry);
      await records.append({
        title: '添加用户导出功能',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询 + 格式转换 + 文件下载',
        actualTime: '55分钟',
        review: '估计较准确',
      });

      const content = await fs.readFile(records.getFilePath(), 'utf-8');
      expect(content).toContain('重构登录模块');
      expect(content).toContain('添加用户导出功能');
    });

    it('should auto-create file if it does not exist', async () => {
      expect(await records.exists()).toBe(false);

      await records.append(sampleEntry);

      expect(await records.exists()).toBe(true);
    });
  });

  describe('appendSync', () => {
    it('should append record synchronously', async () => {
      records.appendSync(sampleEntry);

      const content = await fs.readFile(records.getFilePath(), 'utf-8');
      expect(content).toContain('重构登录模块');
      expect(content).toContain('- **类型**: refactoring');
    });

    it('should auto-create file and directory', async () => {
      const r = new TaskRecords({ baseDir: tempDir, subDir: 'sync/test' });
      r.appendSync(sampleEntry);

      const content = await fs.readFile(r.getFilePath(), 'utf-8');
      expect(content).toContain('# 任务记录');
      expect(content).toContain('重构登录模块');
    });
  });

  describe('readAll', () => {
    it('should return empty string when file does not exist', async () => {
      const content = await records.readAll();
      expect(content).toBe('');
    });

    it('should return full file content', async () => {
      await records.append(sampleEntry);
      const content = await records.readAll();
      expect(content).toContain('# 任务记录');
      expect(content).toContain('重构登录模块');
    });
  });

  describe('list', () => {
    it('should return empty array when no records', async () => {
      await records.ensureFile();
      const result = await records.list();
      expect(result).toEqual([]);
    });

    it('should return empty array when file does not exist', async () => {
      const result = await records.list();
      expect(result).toEqual([]);
    });

    it('should parse single record', async () => {
      await records.append(sampleEntry);

      const result = await records.list();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('重构登录模块');
      expect(result[0].date).toBe(new Date().toISOString().split('T')[0]);
      expect(result[0].raw).toContain('- **类型**: refactoring');
    });

    it('should parse multiple records', async () => {
      await records.append(sampleEntry);
      await records.append({
        title: '添加用户导出功能',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询',
        actualTime: '55分钟',
        review: '估计较准确',
      });
      await records.append({
        title: '修复登录Bug',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单的空指针异常',
        actualTime: '10分钟',
        review: '定位很快，修复简单',
      });

      const result = await records.list();
      expect(result).toHaveLength(3);
      expect(result[0].title).toBe('重构登录模块');
      expect(result[1].title).toBe('添加用户导出功能');
      expect(result[2].title).toBe('修复登录Bug');
    });

    it('should include raw Markdown content for each record', async () => {
      await records.append(sampleEntry);

      const result = await records.list();
      expect(result[0].raw).toContain('- **估计时间**: 30分钟');
      expect(result[0].raw).toContain('- **实际时间**: 45分钟');
      expect(result[0].raw).toContain('- **复盘**:');
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await records.append(sampleEntry);
      await records.append({
        title: '添加用户导出功能',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询',
        actualTime: '55分钟',
        review: '估计较准确',
      });
      await records.append({
        title: '修复登录Bug',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单的空指针异常',
        actualTime: '10分钟',
        review: '定位很快',
      });
    });

    it('should search by title keyword', async () => {
      const result = await records.search('登录');
      expect(result).toHaveLength(2);
      expect(result.some(r => r.title === '重构登录模块')).toBe(true);
      expect(result.some(r => r.title === '修复登录Bug')).toBe(true);
    });

    it('should be case-insensitive', async () => {
      const result = await records.search('REFACTORING');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('重构登录模块');
    });

    it('should search by type', async () => {
      const result = await records.search('feature');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('添加用户导出功能');
    });

    it('should search by review content', async () => {
      const result = await records.search('低估');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('重构登录模块');
    });

    it('should return empty for no matches', async () => {
      const result = await records.search('不存在的关键词');
      expect(result).toHaveLength(0);
    });
  });

  describe('getByType', () => {
    beforeEach(async () => {
      await records.append(sampleEntry); // refactoring
      await records.append({
        title: '修复登录Bug',
        type: 'bugfix',
        estimatedTime: '15分钟',
        estimationBasis: '简单',
        actualTime: '10分钟',
        review: '快',
      });
      await records.append({
        title: '添加导出功能',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '类似报表',
        actualTime: '55分钟',
        review: '准确',
      });
      await records.append({
        title: '修复导出Bug',
        type: 'bugfix',
        estimatedTime: '20分钟',
        estimationBasis: '可能格式问题',
        actualTime: '25分钟',
        review: '稍复杂',
      });
    });

    it('should filter by type', async () => {
      const result = await records.getByType('bugfix');
      expect(result).toHaveLength(2);
      expect(result.every(r => r.raw.includes('- **类型**: bugfix'))).toBe(true);
    });

    it('should return empty for unknown type', async () => {
      const result = await records.getByType('nonexistent');
      expect(result).toHaveLength(0);
    });

    it('should return single match', async () => {
      const result = await records.getByType('feature');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('添加导出功能');
    });
  });

  describe('getRecent', () => {
    it('should return recent records newest first', async () => {
      for (let i = 1; i <= 5; i++) {
        await records.append({
          title: `任务 ${i}`,
          type: 'feature',
          estimatedTime: `${i * 10}分钟`,
          estimationBasis: `估计依据 ${i}`,
          actualTime: `${i * 12}分钟`,
          review: `复盘 ${i}`,
        });
      }

      const result = await records.getRecent(3);
      expect(result).toHaveLength(3);
      // Newest first
      expect(result[0].title).toBe('任务 5');
      expect(result[1].title).toBe('任务 4');
      expect(result[2].title).toBe('任务 3');
    });

    it('should default to 10 records', async () => {
      for (let i = 1; i <= 15; i++) {
        await records.append({
          title: `任务 ${i}`,
          type: 'feature',
          estimatedTime: '10分钟',
          estimationBasis: '依据',
          actualTime: '10分钟',
          review: '复盘',
        });
      }

      const result = await records.getRecent();
      expect(result).toHaveLength(10);
    });

    it('should return all records if fewer than count', async () => {
      await records.append(sampleEntry);
      const result = await records.getRecent(10);
      expect(result).toHaveLength(1);
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      expect(await records.exists()).toBe(false);
    });

    it('should return true after file is created', async () => {
      await records.ensureFile();
      expect(await records.exists()).toBe(true);
    });
  });

  describe('count', () => {
    it('should return 0 when no records', async () => {
      expect(await records.count()).toBe(0);
    });

    it('should return correct count', async () => {
      await records.append(sampleEntry);
      expect(await records.count()).toBe(1);

      await records.append({
        title: '另一个任务',
        type: 'feature',
        estimatedTime: '1小时',
        estimationBasis: '经验',
        actualTime: '50分钟',
        review: '不错',
      });
      expect(await records.count()).toBe(2);
    });
  });

  describe('Markdown format verification', () => {
    it('should produce valid Markdown matching Issue #1234 spec', async () => {
      await records.append({
        title: '添加用户导出功能',
        type: 'feature-small',
        estimatedTime: '1小时',
        estimationBasis: '需要数据查询 + 格式转换 + 文件下载，参照之前的报表功能',
        actualTime: '55分钟',
        review: '估计较准确',
      });

      const content = await fs.readFile(records.getFilePath(), 'utf-8');

      // Verify structure matches the spec from Issue #1234
      expect(content).toMatch(/^# 任务记录\n\n/m);         // Header
      expect(content).toMatch(/^## \d{4}-\d{2}-\d{2} /m);  // Date heading
      expect(content).toMatch(/^- \*\*类型\*\*: /m);        // Type field
      expect(content).toMatch(/^- \*\*估计时间\*\*: /m);    // Estimated time
      expect(content).toMatch(/^- \*\*估计依据\*\*: /m);    // Estimation basis
      expect(content).toMatch(/^- \*\*实际时间\*\*: /m);    // Actual time
      expect(content).toMatch(/^- \*\*复盘\*\*: /m);        // Review
    });

    it('should NOT use any structured data format', async () => {
      await records.append(sampleEntry);

      const content = await fs.readFile(records.getFilePath(), 'utf-8');

      // Should NOT contain JSON, arrays, or structured delimiters
      expect(content).not.toMatch(/\[[\s]*\{/);   // No JSON array
      expect(content).not.toMatch(/\{[\s]*"/);     // No JSON object
      expect(content).not.toContain('```json');    // No JSON code block
    });

    it('should be human-readable in any text editor', async () => {
      await records.append(sampleEntry);

      const content = await fs.readFile(records.getFilePath(), 'utf-8');

      // Verify it reads naturally as plain text
      const lines = content.split('\n');
      expect(lines[0]).toBe('# 任务记录');
      // Find the record heading
      const recordLine = lines.find(l => l.startsWith('## '));
      expect(recordLine).toBeTruthy();
      expect(recordLine!).toContain(sampleEntry.title);
    });
  });
});
