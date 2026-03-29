/**
 * Unit tests for ETA file utilities.
 *
 * Tests Markdown file management for the ETA prediction system:
 * - File path resolution
 * - Default file creation
 * - Reading/writing task records and rules
 * - Append operations
 *
 * Uses real file system operations via temp directories (no fs mocking).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  getTaskRecordsPath,
  getEtaRulesPath,
  getClaudeDir,
  ensureEtaFiles,
  readTaskRecords,
  readEtaRules,
  appendTaskRecord,
  updateEtaRules,
} from './eta-files.js';

describe('ETA Files', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eta-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getTaskRecordsPath', () => {
    it('should return correct path for task-records.md', () => {
      const result = getTaskRecordsPath('/workspace');
      expect(result).toBe('/workspace/.claude/task-records.md');
    });

    it('should handle workspace dir with trailing slash', () => {
      const result = getTaskRecordsPath('/workspace/');
      expect(result).toBe('/workspace/.claude/task-records.md');
    });
  });

  describe('getEtaRulesPath', () => {
    it('should return correct path for eta-rules.md', () => {
      const result = getEtaRulesPath('/workspace');
      expect(result).toBe('/workspace/.claude/eta-rules.md');
    });
  });

  describe('getClaudeDir', () => {
    it('should return correct path for .claude directory', () => {
      const result = getClaudeDir('/workspace');
      expect(result).toBe('/workspace/.claude');
    });
  });

  describe('ensureEtaFiles', () => {
    it('should create .claude directory and both files when none exist', async () => {
      await ensureEtaFiles(tempDir);

      const claudeDir = getClaudeDir(tempDir);
      await expect(fs.access(claudeDir)).resolves.toBeUndefined();
      await expect(fs.access(getTaskRecordsPath(tempDir))).resolves.toBeUndefined();
      await expect(fs.access(getEtaRulesPath(tempDir))).resolves.toBeUndefined();
    });

    it('should create task-records.md with default content', async () => {
      await ensureEtaFiles(tempDir);

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('# 任务执行记录');
      expect(content).toContain('ETA 预估系统');
    });

    it('should create eta-rules.md with default content', async () => {
      await ensureEtaFiles(tempDir);

      const content = await readEtaRules(tempDir);
      expect(content).toContain('# ETA 估计规则');
      expect(content).toContain('任务类型基准时间');
      expect(content).toContain('经验规则');
    });

    it('should not overwrite existing files', async () => {
      await ensureEtaFiles(tempDir);

      // Write custom content to task-records.md
      const customRecords = '# Custom Records\nSome custom content';
      await fs.writeFile(getTaskRecordsPath(tempDir), customRecords, 'utf-8');

      // Call ensureEtaFiles again
      await ensureEtaFiles(tempDir);

      // File should still have custom content
      const content = await readTaskRecords(tempDir);
      expect(content).toBe(customRecords);
    });

    it('should not overwrite existing eta-rules.md', async () => {
      await ensureEtaFiles(tempDir);

      const customRules = '# Custom Rules\nMy custom rules';
      await fs.writeFile(getEtaRulesPath(tempDir), customRules, 'utf-8');

      await ensureEtaFiles(tempDir);

      const content = await readEtaRules(tempDir);
      expect(content).toBe(customRules);
    });
  });

  describe('readTaskRecords', () => {
    it('should return empty string when file does not exist', async () => {
      const content = await readTaskRecords(tempDir);
      expect(content).toBe('');
    });

    it('should return file content when file exists', async () => {
      await ensureEtaFiles(tempDir);
      const content = await readTaskRecords(tempDir);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('# 任务执行记录');
    });
  });

  describe('readEtaRules', () => {
    it('should return empty string when file does not exist', async () => {
      const content = await readEtaRules(tempDir);
      expect(content).toBe('');
    });

    it('should return file content when file exists', async () => {
      await ensureEtaFiles(tempDir);
      const content = await readEtaRules(tempDir);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('# ETA 估计规则');
    });
  });

  describe('appendTaskRecord', () => {
    it('should create files if they do not exist and append record', async () => {
      const record = '## 2026-03-28 Test Task\n- **类型**: bugfix\n- **实际时间**: 30分钟';

      await appendTaskRecord(tempDir, record);

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('# 任务执行记录');
      expect(content).toContain('## 2026-03-28 Test Task');
      expect(content).toContain('bugfix');
      expect(content).toContain('30分钟');
    });

    it('should append record to existing content', async () => {
      await ensureEtaFiles(tempDir);

      const record1 = '## 2026-03-28 First Task\n- **类型**: feature\n- **实际时间**: 1小时';
      const record2 = '## 2026-03-29 Second Task\n- **类型**: bugfix\n- **实际时间**: 30分钟';

      await appendTaskRecord(tempDir, record1);
      await appendTaskRecord(tempDir, record2);

      const content = await readTaskRecords(tempDir);
      expect(content).toContain('First Task');
      expect(content).toContain('Second Task');
      expect(content).toContain('feature');
      expect(content).toContain('bugfix');
    });

    it('should preserve default content when appending', async () => {
      await ensureEtaFiles(tempDir);

      const originalContent = await readTaskRecords(tempDir);
      const record = '## 2026-03-28 New Record\n- **实际时间**: 45分钟';

      await appendTaskRecord(tempDir, record);

      const updatedContent = await readTaskRecords(tempDir);
      expect(updatedContent).toContain(originalContent.split('\n')[0]); // Header preserved
      expect(updatedContent).toContain('New Record');
    });
  });

  describe('updateEtaRules', () => {
    it('should create files if they do not exist and write content', async () => {
      const newRules = '# Updated Rules\nNew rules content';

      await updateEtaRules(tempDir, newRules);

      const content = await readEtaRules(tempDir);
      expect(content).toBe(newRules);
    });

    it('should replace entire eta-rules.md content', async () => {
      await ensureEtaFiles(tempDir);

      const originalContent = await readEtaRules(tempDir);
      expect(originalContent).toContain('# ETA 估计规则');

      const newRules = '# Updated ETA Rules\n\n## New Section\nUpdated content here';

      await updateEtaRules(tempDir, newRules);

      const content = await readEtaRules(tempDir);
      expect(content).toBe(newRules);
      expect(content).not.toContain('任务类型基准时间'); // Old content gone
    });

    it('should handle multi-line content with Markdown formatting', async () => {
      const complexRules = `# ETA Rules v2

## Task Types

| Type | Base Time |
|------|-----------|
| bugfix | 15-30min |

## Rules

1. **Complex task** → × 2
2. **Simple task** → × 0.5

## Updated

- 2026-03-29: Major rule revision
`;

      await updateEtaRules(tempDir, complexRules);

      const content = await readEtaRules(tempDir);
      expect(content).toContain('| Type | Base Time |');
      expect(content).toContain('Complex task');
      expect(content).toContain('Major rule revision');
    });
  });

  describe('integration: full workflow', () => {
    it('should support the full record-learn-predict workflow', async () => {
      // Step 1: Ensure files exist
      await ensureEtaFiles(tempDir);

      // Step 2: Record a completed task
      const record = `## 2026-03-28 修复登录超时

- **类型**: bugfix
- **估计时间**: 20分钟
- **估计依据**: 简单超时问题
- **实际时间**: 2.5小时
- **复盘**: 严重低估，根因是连接池泄漏
- **关键词**: bug, timeout, connection, pool
- **复杂度因素**: 架构级缺陷
`;
      await appendTaskRecord(tempDir, record);

      // Step 3: Read records for learning
      const records = await readTaskRecords(tempDir);
      expect(records).toContain('修复登录超时');
      expect(records).toContain('2.5小时');

      // Step 4: Read rules
      const rules = await readEtaRules(tempDir);
      expect(rules).toContain('bugfix');
      expect(rules).toContain('15-60分钟');

      // Step 5: Update rules based on learning
      const updatedRules = rules + `
## 最近更新

- 2026-03-28: 新增规则 - 表面超时问题可能是架构缺陷，基准时间应 × 3
`;
      await updateEtaRules(tempDir, updatedRules);

      const finalRules = await readEtaRules(tempDir);
      expect(finalRules).toContain('架构缺陷');
    });
  });
});
