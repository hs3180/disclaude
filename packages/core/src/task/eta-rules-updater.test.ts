/**
 * Tests for EtaRulesUpdater.
 *
 * Issue #1234 Phase 2: ETA rules learning from task records.
 * Verifies pattern extraction, analysis, and rules file updating.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseTimeToMinutes,
  extractRecordsFromMarkdown,
  analyzeTypePatterns,
  EtaRulesUpdater,
} from './eta-rules-updater.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eta-rules-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ===== parseTimeToMinutes =====

describe('parseTimeToMinutes', () => {
  it('should parse minutes', () => {
    expect(parseTimeToMinutes('30分钟')).toBe(30);
  });

  it('should parse hours', () => {
    expect(parseTimeToMinutes('2小时')).toBe(120);
  });

  it('should parse hours and minutes', () => {
    expect(parseTimeToMinutes('1小时30分钟')).toBe(90);
  });

  it('should return 0 for empty string', () => {
    expect(parseTimeToMinutes('')).toBe(0);
  });

  it('should return 0 for "未估计"', () => {
    expect(parseTimeToMinutes('未估计')).toBe(0);
  });

  it('should return 0 for "未记录"', () => {
    expect(parseTimeToMinutes('未记录')).toBe(0);
  });

  it('should parse plain number as minutes', () => {
    expect(parseTimeToMinutes('45')).toBe(45);
  });
});

// ===== extractRecordsFromMarkdown =====

describe('extractRecordsFromMarkdown', () => {
  it('should extract a single record', () => {
    const content = `# Task Records

## 2026-05-18 Fix login bug

- **类型**: bugfix
- **估计时间**: 30分钟
- **估计依据**: Similar to previous form fix
- **实际时间**: 45分钟
- **复盘**: Underestimated complexity
`;

    const records = extractRecordsFromMarkdown(content);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe('Fix login bug');
    expect(records[0].type).toBe('bugfix');
    expect(records[0].estimatedTime).toBe('30分钟');
    expect(records[0].actualTime).toBe('45分钟');
    expect(records[0].estimationBasis).toBe('Similar to previous form fix');
    expect(records[0].review).toBe('Underestimated complexity');
  });

  it('should extract multiple records', () => {
    const content = `# Task Records

## 2026-05-18 Task A

- **类型**: feature
- **估计时间**: 1小时
- **实际时间**: 55分钟

## 2026-05-19 Task B

- **类型**: bugfix
- **估计时间**: 15分钟
- **实际时间**: 2小时
`;

    const records = extractRecordsFromMarkdown(content);
    expect(records).toHaveLength(2);
    expect(records[0].title).toBe('Task A');
    expect(records[1].title).toBe('Task B');
  });

  it('should handle records with missing optional fields', () => {
    const content = `# Task Records

## 2026-05-18 Quick fix

- **类型**: chore
- **估计时间**: 未估计
- **实际时间**: 5分钟
`;

    const records = extractRecordsFromMarkdown(content);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('chore');
    expect(records[0].estimationBasis).toBe('');
    expect(records[0].review).toBe('');
  });

  it('should return empty array for empty content', () => {
    const records = extractRecordsFromMarkdown('');
    expect(records).toHaveLength(0);
  });

  it('should skip header-only content', () => {
    const content = '# Task Records\n';
    const records = extractRecordsFromMarkdown(content);
    expect(records).toHaveLength(0);
  });
});

// ===== analyzeTypePatterns =====

describe('analyzeTypePatterns', () => {
  it('should compute average ratio per type', () => {
    const records = [
      { type: 'bugfix', estimatedTime: '30分钟', actualTime: '45分钟' },
      { type: 'bugfix', estimatedTime: '30分钟', actualTime: '60分钟' },
    ];

    const patterns = analyzeTypePatterns(records);
    const bugfix = patterns.get('bugfix')!;

    expect(bugfix.count).toBe(2);
    expect(bugfix.avgRatio).toBeGreaterThan(1); // Underestimated
    expect(bugfix.avgActualMin).toBe(53); // (45 + 60) / 2 = 52.5 → 53
  });

  it('should separate types correctly', () => {
    const records = [
      { type: 'bugfix', estimatedTime: '30分钟', actualTime: '60分钟' },
      { type: 'feature', estimatedTime: '1小时', actualTime: '55分钟' },
    ];

    const patterns = analyzeTypePatterns(records);
    expect(patterns.has('bugfix')).toBe(true);
    expect(patterns.has('feature')).toBe(true);
  });

  it('should skip records with missing times', () => {
    const records = [
      { type: 'bugfix', estimatedTime: '', actualTime: '45分钟' },
      { type: 'bugfix', estimatedTime: '30分钟', actualTime: '未记录' },
      { type: 'bugfix', estimatedTime: '30分钟', actualTime: '45分钟' },
    ];

    const patterns = analyzeTypePatterns(records);
    const bugfix = patterns.get('bugfix')!;
    expect(bugfix.count).toBe(1); // Only the third record has both times
  });

  it('should return empty map for no valid records', () => {
    const records = [
      { type: 'bugfix', estimatedTime: '', actualTime: '' },
    ];

    const patterns = analyzeTypePatterns(records);
    expect(patterns.size).toBe(0);
  });

  it('should detect overestimation (ratio < 1)', () => {
    const records = [
      { type: 'chore', estimatedTime: '1小时', actualTime: '10分钟' },
      { type: 'chore', estimatedTime: '1小时', actualTime: '15分钟' },
    ];

    const patterns = analyzeTypePatterns(records);
    const chore = patterns.get('chore')!;
    expect(chore.avgRatio).toBeLessThan(1);
  });
});

// ===== EtaRulesUpdater =====

describe('EtaRulesUpdater', () => {
  let updater: EtaRulesUpdater;

  beforeEach(() => {
    updater = new EtaRulesUpdater(tempDir);
  });

  describe('getRulesPath', () => {
    it('should return path under .claude/eta-rules.md', () => {
      const result = updater.getRulesPath();
      expect(result).toContain('.claude');
      expect(result).toContain('eta-rules.md');
    });
  });

  describe('readRules', () => {
    it('should return default template when no rules file exists', async () => {
      const rules = await updater.readRules();
      expect(rules).toContain('# ETA 估计规则');
      expect(rules).toContain('任务类型基准时间');
    });

    it('should return existing rules content', async () => {
      await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.claude', 'eta-rules.md'),
        '# Custom Rules\n',
        'utf-8'
      );

      const rules = await updater.readRules();
      expect(rules).toBe('# Custom Rules\n');
    });
  });

  describe('ensureRulesFile', () => {
    it('should create default rules file if none exists', async () => {
      await updater.ensureRulesFile();

      const content = await fs.readFile(updater.getRulesPath(), 'utf-8');
      expect(content).toContain('# ETA 估计规则');
    });

    it('should not overwrite existing rules file', async () => {
      await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.claude', 'eta-rules.md'),
        '# Existing Rules\n',
        'utf-8'
      );

      await updater.ensureRulesFile();

      const content = await fs.readFile(updater.getRulesPath(), 'utf-8');
      expect(content).toBe('# Existing Rules\n');
    });
  });

  describe('updateRules', () => {
    it('should return empty string when no task records exist', async () => {
      const result = await updater.updateRules();
      expect(result).toBe('');
    });

    it('should update rules from task records', async () => {
      // Create task records
      const claudeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });

      const records = `# Task Records

## 2026-05-18 Fix login bug

- **类型**: bugfix
- **估计时间**: 30分钟
- **实际时间**: 45分钟

## 2026-05-19 Fix logout bug

- **类型**: bugfix
- **估计时间**: 30分钟
- **实际时间**: 60分钟

## 2026-05-20 Add export feature

- **类型**: feature
- **估计时间**: 1小时
- **实际时间**: 55分钟
`;
      await fs.writeFile(
        path.join(claudeDir, 'task-records.md'),
        records,
        'utf-8'
      );

      const result = await updater.updateRules();

      expect(result).toContain('# ETA 估计规则');
      expect(result).toContain('bugfix');
      expect(result).toContain('feature');
      expect(result).toContain('自动更新');
      expect(result).toContain('3 条任务记录');
    });

    it('should update baseline table with learned data', async () => {
      const claudeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });

      // Create records where bugfix tasks are consistently underestimated
      const records = `# Task Records

## 2026-05-18 Fix bug A

- **类型**: bugfix
- **估计时间**: 30分钟
- **实际时间**: 2小时

## 2026-05-19 Fix bug B

- **类型**: bugfix
- **估计时间**: 30分钟
- **实际时间**: 1小时30分钟
`;
      await fs.writeFile(
        path.join(claudeDir, 'task-records.md'),
        records,
        'utf-8'
      );

      const result = await updater.updateRules();

      // Bugfix should show as underestimated in bias analysis
      expect(result).toContain('低估场景');
      expect(result).toContain('bugfix');
    });

    it('should persist updated rules to file', async () => {
      const claudeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });

      const records = `# Task Records

## 2026-05-18 Quick task

- **类型**: chore
- **估计时间**: 10分钟
- **实际时间**: 5分钟

## 2026-05-19 Another quick task

- **类型**: chore
- **估计时间**: 15分钟
- **实际时间**: 8分钟
`;
      await fs.writeFile(
        path.join(claudeDir, 'task-records.md'),
        records,
        'utf-8'
      );

      await updater.updateRules();

      // Verify the file was written
      const fileContent = await fs.readFile(updater.getRulesPath(), 'utf-8');
      expect(fileContent).toContain('# ETA 估计规则');
      expect(fileContent).toContain('chore');
    });

    it('should handle records with only some having both times', async () => {
      const claudeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });

      const records = `# Task Records

## 2026-05-18 Complete record

- **类型**: bugfix
- **估计时间**: 30分钟
- **实际时间**: 45分钟

## 2026-05-19 Incomplete record

- **类型**: bugfix
- **估计时间**: 未估计
- **实际时间**: 30分钟
`;
      await fs.writeFile(
        path.join(claudeDir, 'task-records.md'),
        records,
        'utf-8'
      );

      // Should still work, just using the complete record
      const result = await updater.updateRules();
      // Only 1 complete record for bugfix — not enough for pattern (need >= 2)
      // So it should still use default baselines
      expect(result).toContain('默认值');
    });
  });
});
