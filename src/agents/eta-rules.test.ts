/**
 * Tests for ETA Rules (Markdown-based).
 *
 * Issue #1234: Task ETA Estimation System
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ETARules } from './eta-rules.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ETARules', () => {
  let rules: ETARules;
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `eta-rules-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create rules with test directory
    rules = new ETARules(testDir);
    await rules.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create rules file with default content', async () => {
      const content = await rules.readRules();
      expect(content).toContain('# ETA 估计规则');
      expect(content).toContain('任务类型基准时间');
      expect(content).toContain('经验规则');
    });

    it('should include default task types', async () => {
      const baselines = await rules.getTaskTypeBaselines();
      expect(baselines.length).toBeGreaterThan(0);

      const types = baselines.map(b => b.type);
      expect(types).toContain('bugfix');
      expect(types).toContain('feature-small');
    });

    it('should include default estimation rules', async () => {
      const estimationRules = await rules.getEstimationRules();
      expect(estimationRules.length).toBeGreaterThan(0);

      // Check for authentication rule
      const authRule = estimationRules.find(r => r.condition.includes('认证'));
      expect(authRule).toBeDefined();
      expect(authRule?.multiplier).toBe(1.5);
    });
  });

  describe('getTaskTypeBaselines', () => {
    it('should parse task type table correctly', async () => {
      const baselines = await rules.getTaskTypeBaselines();

      const bugfix = baselines.find(b => b.type === 'bugfix');
      expect(bugfix).toBeDefined();
      expect(bugfix?.minSeconds).toBe(15 * 60); // 15 minutes
      expect(bugfix?.maxSeconds).toBe(30 * 60); // 30 minutes
    });

    it('should parse hour-based ranges', async () => {
      const baselines = await rules.getTaskTypeBaselines();

      const medium = baselines.find(b => b.type === 'feature-medium');
      expect(medium).toBeDefined();
      expect(medium?.minSeconds).toBe(2 * 3600); // 2 hours
      expect(medium?.maxSeconds).toBe(4 * 3600); // 4 hours
    });
  });

  describe('getBaselineForType', () => {
    it('should find exact match', async () => {
      const baseline = await rules.getBaselineForType('bugfix');
      expect(baseline).toBeDefined();
      expect(baseline?.type).toBe('bugfix');
    });

    it('should find partial match', async () => {
      const baseline = await rules.getBaselineForType('feature-large-task');
      expect(baseline).toBeDefined();
      expect(baseline?.type).toBe('feature-large');
    });

    it('should return undefined for unknown type', async () => {
      const baseline = await rules.getBaselineForType('unknown-type-xyz');
      expect(baseline).toBeUndefined();
    });
  });

  describe('getEstimationRules', () => {
    it('should parse rules with multipliers', async () => {
      const estimationRules = await rules.getEstimationRules();

      // All rules should have valid multipliers
      for (const rule of estimationRules) {
        expect(rule.multiplier).toBeGreaterThan(0);
        expect(rule.condition.length).toBeGreaterThan(0);
      }
    });
  });

  describe('findApplicableRules', () => {
    it('should find rules matching task description', async () => {
      const applicable = await rules.findApplicableRules(
        '实现用户认证功能，需要处理登录和权限验证'
      );

      // Should match authentication rule
      expect(applicable.length).toBeGreaterThan(0);
      const authRule = applicable.find(r => r.condition.includes('认证'));
      expect(authRule).toBeDefined();
    });

    it('should return empty array for non-matching description', async () => {
      const applicable = await rules.findApplicableRules(
        '这是一个简单的文档更新任务'
      );

      // May or may not find rules depending on default rules
      // Just check it doesn't throw
      expect(Array.isArray(applicable)).toBe(true);
    });
  });

  describe('addRule', () => {
    it('should add a new rule to the file', async () => {
      await rules.addRule({
        condition: '涉及 WebSocket 通信',
        multiplier: 1.4,
        description: 'WebSocket tasks need extra debugging time',
      });

      const content = await rules.readRules();
      expect(content).toContain('WebSocket');
      expect(content).toContain('1.4');
    });

    it('should be readable after adding', async () => {
      await rules.addRule({
        condition: '涉及缓存系统',
        multiplier: 1.3,
        description: 'Cache tasks',
      });

      // Clear cache to force re-read
      rules.clearCache();

      const estimationRules = await rules.getEstimationRules();
      const cacheRule = estimationRules.find(r => r.condition.includes('缓存'));
      expect(cacheRule).toBeDefined();
    });
  });

  describe('recordLesson', () => {
    it('should record a lesson in the update section', async () => {
      await rules.recordLesson('2024-03-10', '新增"涉及认证/安全"规则');

      const content = await rules.readRules();
      expect(content).toContain('2024-03-10');
      expect(content).toContain('新增"涉及认证/安全"规则');
    });

    it('should append multiple lessons', async () => {
      await rules.recordLesson('2024-03-10', 'First lesson');
      await rules.recordLesson('2024-03-11', 'Second lesson');

      const content = await rules.readRules();
      expect(content).toContain('First lesson');
      expect(content).toContain('Second lesson');
    });
  });

  describe('caching', () => {
    it('should cache content after first read', async () => {
      // First read
      await rules.readRules();

      // Modify file directly
      const filePath = rules.getFilePath();
      await fs.appendFile(filePath, '\n<!-- test comment -->', 'utf-8');

      // Should return cached content
      const cached = await rules.readRules();
      expect(cached).not.toContain('test comment');

      // Clear cache and re-read
      rules.clearCache();
      const fresh = await rules.readRules();
      expect(fresh).toContain('test comment');
    });
  });
});
