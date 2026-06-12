/**
 * Tests for LoopParser.
 *
 * Verifies LOOP.md parsing, step mutation, and progress tracking.
 *
 * Related #4039: Loop System — LoopParser utility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LoopParser } from './loop-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_LOOP_MD = `# Implement User Authentication

## 配置
- **clear_context_per_step**: false
- **max_duration**: 1h
- **max_consecutive_failures**: 3

## 目标
实现用户认证功能，包括登录、注册和密码重置。

## 约束
- 使用 JWT
- 不修改现有 API 路由

## 待办
- [ ] Create User model
- [ ] Implement login endpoint
- [x] Setup database schema
- ~[x]~ Write unit tests (失败：测试框架未安装)
- [ ] Add password reset flow

## 进度记录
> [2026-01-01T00:00:00.000Z] Database schema setup completed.
`;

const MINIMAL_LOOP_MD = `# Simple Task

## 待办
- [ ] Step A
- [ ] Step B
`;

const NO_CHECKBOXES_MD = `# No Tasks

## 目标
Just a goal with no steps.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-parser-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeLoopFile(content: string, filename = 'LOOP.md'): Promise<string> {
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

describe('LoopParser', () => {
  describe('parseContent', () => {
    it('should parse title', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      expect(doc.title).toBe('Implement User Authentication');
    });

    it('should parse config section', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      expect(doc.config.clearContextPerStep).toBe(false);
      expect(doc.config.maxDurationMs).toBe(3600 * 1000); // 1h
      expect(doc.config.maxConsecutiveFailures).toBe(3);
    });

    it('should use default config when section is missing', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(MINIMAL_LOOP_MD);
      expect(doc.config.clearContextPerStep).toBe(false);
      expect(doc.config.maxDurationMs).toBe(2 * 3600 * 1000); // 2h default
      expect(doc.config.maxConsecutiveFailures).toBe(3);
    });

    it('should parse objective', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      expect(doc.objective).toContain('实现用户认证功能');
    });

    it('should parse constraints', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      expect(doc.constraints).toContain('JWT');
    });

    it('should parse all checkbox states', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);

      expect(doc.steps).toHaveLength(5);
      expect(doc.steps[0]!.state).toBe('pending');
      expect(doc.steps[0]!.text).toBe('Create User model');
      expect(doc.steps[1]!.state).toBe('pending');
      expect(doc.steps[2]!.state).toBe('completed');
      expect(doc.steps[2]!.text).toBe('Setup database schema');
      expect(doc.steps[3]!.state).toBe('failed');
      expect(doc.steps[3]!.text).toBe('Write unit tests');
      expect(doc.steps[3]!.note).toBe('(失败：测试框架未安装)');
      expect(doc.steps[4]!.state).toBe('pending');
    });

    it('should parse progress notes', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      expect(doc.progressNotes).toContain('Database schema setup completed');
    });

    it('should handle minimal LOOP.md with no sections', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(MINIMAL_LOOP_MD);
      expect(doc.title).toBe('Simple Task');
      expect(doc.steps).toHaveLength(2);
      expect(doc.objective).toBe('');
    });

    it('should handle LOOP.md with no checkboxes', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(NO_CHECKBOXES_MD);
      expect(doc.steps).toHaveLength(0);
    });

    it('should preserve raw content', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      expect(doc.rawContent).toBe(SAMPLE_LOOP_MD);
    });
  });

  describe('parse / parseSync (file I/O)', () => {
    it('should parse from file asynchronously', async () => {
      const filePath = await writeLoopFile(SAMPLE_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = await parser.parse();
      expect(doc.title).toBe('Implement User Authentication');
      expect(doc.steps).toHaveLength(5);
    });

    it('should parse from file synchronously', async () => {
      const filePath = await writeLoopFile(SAMPLE_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = parser.parseSync();
      expect(doc.title).toBe('Implement User Authentication');
      expect(doc.steps).toHaveLength(5);
    });

    it('should throw for missing file', async () => {
      const parser = new LoopParser(path.join(tempDir, 'nonexistent.md'));
      await expect(parser.parse()).rejects.toThrow();
    });
  });

  describe('updateStep', () => {
    it('should mark a pending step as completed', async () => {
      const filePath = await writeLoopFile(MINIMAL_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = await parser.updateStep(0, 'completed');
      expect(doc.steps[0]!.state).toBe('completed');
    });

    it('should mark a step as failed with note', async () => {
      const filePath = await writeLoopFile(MINIMAL_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = await parser.updateStep(1, 'failed', '(失败：API 超时)');
      expect(doc.steps[1]!.state).toBe('failed');
      expect(doc.steps[1]!.note).toBe('(失败：API 超时)');

      // Verify persisted file
      const reRead = await parser.parse();
      expect(reRead.steps[1]!.state).toBe('failed');
    });

    it('should mark a failed step back to pending', async () => {
      const filePath = await writeLoopFile(SAMPLE_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = await parser.updateStep(3, 'pending');
      expect(doc.steps[3]!.state).toBe('pending');
      expect(doc.rawContent).toContain('- [ ] Write unit tests');
    });

    it('should throw for out-of-range index', async () => {
      const filePath = await writeLoopFile(MINIMAL_LOOP_MD);
      const parser = new LoopParser(filePath);
      await expect(parser.updateStep(99, 'completed')).rejects.toThrow('out of range');
    });

    it('should not mutate other steps', async () => {
      const filePath = await writeLoopFile(SAMPLE_LOOP_MD);
      const parser = new LoopParser(filePath);
      await parser.updateStep(0, 'completed');
      const doc = await parser.parse();
      // Step 2 was already completed, step 3 was failed — unchanged
      expect(doc.steps[2]!.state).toBe('completed');
      expect(doc.steps[3]!.state).toBe('failed');
    });

    it('should preserve whitespace indentation', async () => {
      const indented = '# Test\n\n## 待办\n  - [ ] Step A\n';
      const filePath = await writeLoopFile(indented);
      const parser = new LoopParser(filePath);
      const doc = await parser.updateStep(0, 'completed');
      expect(doc.rawContent).toContain('  - [x] Step A');
    });
  });

  describe('appendProgress', () => {
    it('should append to existing progress section', async () => {
      const filePath = await writeLoopFile(SAMPLE_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = await parser.appendProgress('Login endpoint implemented');
      expect(doc.progressNotes).toContain('Login endpoint implemented');
    });

    it('should create progress section if missing', async () => {
      const filePath = await writeLoopFile(MINIMAL_LOOP_MD);
      const parser = new LoopParser(filePath);
      const doc = await parser.appendProgress('First step done');
      expect(doc.progressNotes).toContain('First step done');
      expect(doc.rawContent).toContain('## 进度记录');
    });

    it('should persist progress notes to file', async () => {
      const filePath = await writeLoopFile(MINIMAL_LOOP_MD);
      const parser = new LoopParser(filePath);
      await parser.appendProgress('Note 1');
      await parser.appendProgress('Note 2');
      const doc = await parser.parse();
      expect(doc.progressNotes).toContain('Note 1');
      expect(doc.progressNotes).toContain('Note 2');
    });
  });

  describe('getProgress', () => {
    it('should count all states correctly', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(SAMPLE_LOOP_MD);
      const progress = LoopParser.getProgress(doc);
      expect(progress.total).toBe(5);
      expect(progress.completed).toBe(1);
      expect(progress.failed).toBe(1);
      expect(progress.pending).toBe(3);
    });

    it('should handle all pending', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(MINIMAL_LOOP_MD);
      const progress = LoopParser.getProgress(doc);
      expect(progress.total).toBe(2);
      expect(progress.pending).toBe(2);
      expect(progress.completed).toBe(0);
      expect(progress.failed).toBe(0);
    });

    it('should handle empty steps', () => {
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(NO_CHECKBOXES_MD);
      const progress = LoopParser.getProgress(doc);
      expect(progress.total).toBe(0);
    });
  });

  describe('static helpers', () => {
    it('isCheckboxLine should detect pending checkbox', () => {
      expect(LoopParser.isCheckboxLine('- [ ] Step A')).toBe(true);
    });

    it('isCheckboxLine should detect completed checkbox', () => {
      expect(LoopParser.isCheckboxLine('- [x] Step B')).toBe(true);
      expect(LoopParser.isCheckboxLine('- [X] Step B')).toBe(true);
    });

    it('isCheckboxLine should detect failed checkbox', () => {
      expect(LoopParser.isCheckboxLine('- ~[x]~ Step C')).toBe(true);
    });

    it('isCheckboxLine should reject non-checkbox lines', () => {
      expect(LoopParser.isCheckboxLine('- Some bullet point')).toBe(false);
      expect(LoopParser.isCheckboxLine('## Heading')).toBe(false);
      expect(LoopParser.isCheckboxLine('')).toBe(false);
    });

    it('parseCheckboxLine should return null for non-checkbox', () => {
      expect(LoopParser.parseCheckboxLine('not a checkbox', 0)).toBeNull();
    });

    it('parseCheckboxLine should parse correctly', () => {
      const step = LoopParser.parseCheckboxLine('- [ ] Create model', 0);
      expect(step).not.toBeNull();
      expect(step!.text).toBe('Create model');
      expect(step!.state).toBe('pending');
      expect(step!.index).toBe(0);
    });
  });

  describe('config parsing edge cases', () => {
    it('should handle config with trailing comments', () => {
      const content = '# Test\n\n## 配置\n- **max_duration**: 30m # 30 minutes\n';
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(content);
      expect(doc.config.maxDurationMs).toBe(30 * 60 * 1000);
    });

    it('should handle clear_context_per_step true', () => {
      const content = '# Test\n\n## 配置\n- **clear_context_per_step**: true\n';
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(content);
      expect(doc.config.clearContextPerStep).toBe(true);
    });

    it('should parse duration in seconds', () => {
      const content = '# Test\n\n## 配置\n- **max_duration**: 300s\n';
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(content);
      expect(doc.config.maxDurationMs).toBe(300 * 1000);
    });

    it('should handle English section names', () => {
      const content = '# Test\n\n## Config\n- **max_consecutive_failures**: 5\n\n## Objective\nDo the thing\n\n## Todos\n- [ ] Step 1\n- [x] Step 2\n';
      const parser = new LoopParser('/dev/null');
      const doc = parser.parseContent(content);
      expect(doc.config.maxConsecutiveFailures).toBe(5);
      expect(doc.objective).toBe('Do the thing');
      expect(doc.steps).toHaveLength(2);
      expect(doc.steps[0]!.state).toBe('pending');
      expect(doc.steps[1]!.state).toBe('completed');
    });
  });
});
