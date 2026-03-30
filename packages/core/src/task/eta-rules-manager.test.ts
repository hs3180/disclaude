/**
 * Unit tests for ETARulesManager.
 *
 * Tests cover:
 * - File creation with default content
 * - Reading rules
 * - Appending new rules to existing sections
 * - Appending rules to new sections
 * - Update logging
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ETARulesManager } from './eta-rules-manager.js';

describe('ETARulesManager', () => {
  let manager: ETARulesManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eta-rules-test-'));
    manager = new ETARulesManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should set rules file path to .claude/eta-rules.md', () => {
      const expected = path.join(tempDir, '.claude', 'eta-rules.md');
      expect(manager.getRulesFilePath()).toBe(expected);
    });
  });

  describe('getRules', () => {
    it('should create file with default content on first read', async () => {
      const content = await manager.getRules();

      expect(content).toContain('# ETA 估计规则');
      expect(content).toContain('## 任务类型基准时间');
      expect(content).toContain('bugfix');
      expect(content).toContain('feature-small');
      expect(content).toContain('## 经验规则');
      expect(content).toContain('涉及认证/安全的任务');
    });

    it('should return consistent content on subsequent reads', async () => {
      const first = await manager.getRules();
      const second = await manager.getRules();
      expect(first).toBe(second);
    });
  });

  describe('appendRule', () => {
    it('should append rule to existing 经验规则 section', async () => {
      await manager.getRules(); // Ensure file exists
      await manager.appendRule('5. **涉及数据库迁移的任务** → 基准时间 × 2.5');

      const content = await manager.getRules();
      expect(content).toContain('5. **涉及数据库迁移的任务** → 基准时间 × 2.5');
    });

    it('should append rule to a new section when section does not exist', async () => {
      await manager.getRules();
      await manager.appendRule('- 项目A平均偏差: +30%', '项目经验');

      const content = await manager.getRules();
      expect(content).toContain('## 项目经验');
      expect(content).toContain('- 项目A平均偏差: +30%');
    });

    it('should preserve existing content when appending', async () => {
      await manager.getRules();
      const originalContent = await manager.getRules();

      await manager.appendRule('5. **新规则** → 测试');

      const newContent = await manager.getRules();
      // Verify key sections from original content are preserved
      expect(newContent).toContain('# ETA 估计规则');
      expect(newContent).toContain('## 任务类型基准时间');
      expect(newContent).toContain('## 经验规则');
      expect(newContent).toContain('## 历史偏差分析');
      expect(newContent).toContain('涉及认证/安全的任务');
      expect(newContent).toContain('5. **新规则** → 测试');
      // Verify original content lines are all present
      const originalLines = originalContent.trim().split('\n');
      for (const line of originalLines) {
        if (line.trim()) {
          expect(newContent).toContain(line.trim());
        }
      }
    });

    it('should append multiple rules in order', async () => {
      await manager.getRules();

      await manager.appendRule('5. **规则五** → 测试');
      await manager.appendRule('6. **规则六** → 测试');

      const content = await manager.getRules();
      const index5 = content.indexOf('规则五');
      const index6 = content.indexOf('规则六');
      expect(index5).toBeLessThan(index6);
    });
  });

  describe('addUpdateLog', () => {
    it('should add entry under 最近更新 section', async () => {
      await manager.getRules();
      await manager.addUpdateLog('新增数据库迁移规则');

      const content = await manager.getRules();
      expect(content).toContain('## 最近更新');
      expect(content).toContain('新增数据库迁移规则');
    });

    it('should include date in update log entry', async () => {
      await manager.getRules();
      const [date] = new Date().toISOString().split('T');
      await manager.addUpdateLog('测试更新');

      const content = await manager.getRules();
      expect(content).toContain(`- ${date}: 测试更新`);
    });

    it('should create 最近更新 section if it does not exist', async () => {
      // Write minimal content without 最近更新 section
      const minimalPath = manager.getRulesFilePath();
      const dir = path.dirname(minimalPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(minimalPath, '# ETA 估计规则\n\n## 任务类型基准时间\n\n| 类型 | 时间 |\n|------|------|\n\n', 'utf-8');

      manager.resetInitialization();
      await manager.addUpdateLog('首次更新');

      const content = await manager.getRules();
      expect(content).toContain('## 最近更新');
      expect(content).toContain('首次更新');
    });
  });

  describe('resetInitialization', () => {
    it('should allow re-initialization after reset', async () => {
      await manager.getRules();
      manager.resetInitialization();

      const content = await manager.getRules();
      expect(content).toContain('# ETA 估计规则');
    });
  });

  describe('default content', () => {
    it('should include all standard task type baselines', async () => {
      const content = await manager.getRules();

      const expectedTypes = ['bugfix', 'feature-small', 'feature-medium', 'refactoring', 'documentation', 'testing', 'investigation'];
      for (const type of expectedTypes) {
        expect(content).toContain(type);
      }
    });

    it('should include standard experience rules', async () => {
      const content = await manager.getRules();

      expect(content).toContain('涉及认证/安全的任务');
      expect(content).toContain('需要修改核心模块');
      expect(content).toContain('有现成参考代码');
      expect(content).toContain('涉及第三方 API 集成');
    });

    it('should include historical bias analysis', async () => {
      const content = await manager.getRules();

      expect(content).toContain('## 历史偏差分析');
      expect(content).toContain('低估场景');
      expect(content).toContain('高估场景');
    });
  });
});
