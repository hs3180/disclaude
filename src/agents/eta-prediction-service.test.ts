/**
 * Tests for ETA Prediction Service.
 *
 * Issue #1234: Task ETA Estimation System
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ETAPredictionService } from './eta-prediction-service.js';
import { etaTaskRecords, type ETATaskRecord } from './eta-records.js';
import { etaRules, type ETAEstimationRule } from './eta-rules.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ETAPredictionService', () => {
  let service: ETAPredictionService;
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `eta-prediction-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Reset singleton instances with test directory
    const recordsDir = join(testDir, 'records');
    const rulesDir = join(testDir, 'rules');
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.mkdir(rulesDir, { recursive: true });

    // Override paths for testing (using type assertion for private properties)
    (etaTaskRecords as unknown as { recordsFile: string }).recordsFile = join(recordsDir, 'task-records.md');
    (etaRules as unknown as { rulesFile: string }).rulesFile = join(rulesDir, 'eta-rules.md');
    (etaRules as unknown as { initialized: boolean }).initialized = false;
    (etaRules as unknown as { cachedContent: string | null }).cachedContent = null;
    (etaTaskRecords as unknown as { initialized: boolean }).initialized = false;

    await etaTaskRecords.initialize();
    await etaRules.initialize();

    service = new ETAPredictionService();
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('predict', () => {
    it('should provide default prediction for unknown task types', async () => {
      const prediction = await service.predict({
        description: 'Some unknown task',
        taskType: 'unknown-type',
      });

      expect(prediction.estimatedSeconds).toBeGreaterThan(0);
      expect(prediction.estimatedTime).toBeDefined();
      expect(prediction.confidence).toBeGreaterThan(0);
      expect(prediction.basedOn).toBe('default');
      expect(prediction.reasoning.length).toBeGreaterThan(0);
    });

    it('should use rules for known task types', async () => {
      const prediction = await service.predict({
        description: 'Fix a bug in the code',
        taskType: 'bugfix',
      });

      expect(prediction.estimatedSeconds).toBeGreaterThan(0);
      expect(prediction.reasoning.some(r => r.includes('bugfix') || r.includes('Bug'))).toBe(true);
    });

    it('should apply estimation rules when conditions match', async () => {
      const prediction = await service.predict({
        description: 'Implement authentication and security features',
        taskType: 'feature-medium',
      });

      // The prediction should be affected by the security rule (× 1.5)
      expect(prediction.estimatedSeconds).toBeGreaterThan(0);
      expect(prediction.reasoning.length).toBeGreaterThan(0);
    });

    it('should include complexity score in calculation', async () => {
      const lowComplexity = await service.predict({
        description: 'Simple task',
        taskType: 'feature-small',
        complexityScore: 3,
      });

      const highComplexity = await service.predict({
        description: 'Complex task',
        taskType: 'feature-small',
        complexityScore: 9,
      });

      // Higher complexity should result in longer estimate
      expect(highComplexity.estimatedSeconds).toBeGreaterThan(lowComplexity.estimatedSeconds);
    });

    it('should use historical data when available', async () => {
      // Add some historical tasks
      for (let i = 0; i < 5; i++) {
        await etaTaskRecords.recordTask({
          date: `2024-03-${10 + i}`,
          title: `Authentication feature ${i}`,
          taskType: 'feature',
          estimatedTime: '30分钟',
          estimatedSeconds: 1800,
          estimationBasis: 'Test basis',
          actualTime: '35分钟',
          actualSeconds: 2100,
          review: 'Good',
          success: true,
        });
      }

      const prediction = await service.predict({
        description: 'Authentication feature new',
        taskType: 'feature',
      });

      // Should use historical average (~2100 seconds)
      expect(prediction.estimatedSeconds).toBeGreaterThan(1800);
      expect(prediction.basedOn).toBe('historical');
    });
  });

  describe('recordTask', () => {
    it('should record task for future predictions', async () => {
      await service.recordTask({
        date: '2024-03-10',
        title: 'Test feature',
        taskType: 'feature',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Test basis',
        actualTime: '35分钟',
        actualSeconds: 2100,
        review: 'Good estimate',
        success: true,
      });

      const recent = await etaTaskRecords.getRecentTasks(10);
      expect(recent.length).toBe(1);
      expect(recent[0].title).toBe('Test feature');
    });

    it('should record lessons from significant estimation errors', async () => {
      await service.recordTask({
        date: '2024-03-10',
        title: 'Complex authentication task',
        taskType: 'feature',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Simple estimate',
        actualTime: '2小时',
        actualSeconds: 7200,
        review: '严重低估，涉及认证逻辑比预期复杂得多',
        success: true,
      });

      // Check that the task was recorded
      const recent = await etaTaskRecords.getRecentTasks(10);
      expect(recent.length).toBe(1);
    });
  });

  describe('generateExperienceReport', () => {
    it('should generate empty report when no data', async () => {
      const report = await service.generateExperienceReport();

      expect(report).toContain('ETA 经验报告');
      expect(report).toContain('最近任务: 0 个');
    });

    it('should include task statistics', async () => {
      // Add some tasks
      for (let i = 0; i < 5; i++) {
        await etaTaskRecords.recordTask({
          date: `2024-03-${10 + i}`,
          title: `Task ${i}`,
          taskType: 'feature',
          estimatedTime: '30分钟',
          estimatedSeconds: 1800,
          estimationBasis: 'Test',
          actualTime: i < 3 ? '30分钟' : '45分钟',
          actualSeconds: i < 3 ? 1800 : 2700,
          review: 'Good',
          success: true,
        });
      }

      const report = await service.generateExperienceReport();

      expect(report).toContain('最近任务: 5 个');
      expect(report).toContain('成功率');
    });
  });

  describe('formatTime', () => {
    it('should format seconds correctly', () => {
      // Access private method via type assertion
      const formatTime = (service as unknown as { formatTime: (s: number) => string }).formatTime;

      expect(formatTime(30)).toBe('30秒');
      expect(formatTime(60)).toBe('1分钟');
      expect(formatTime(90)).toBe('1分钟30秒');
      expect(formatTime(3600)).toBe('1小时');
      expect(formatTime(5400)).toBe('1小时30分钟');
    });
  });

  describe('extractKeywords', () => {
    it('should extract meaningful keywords', () => {
      // Access private method via type assertion
      const extractKeywords = (service as unknown as { extractKeywords: (s: string) => string[] }).extractKeywords;

      const keywords = extractKeywords('实现用户认证功能和权限管理模块');
      expect(keywords).toContain('实现');
      expect(keywords).toContain('用户');
      expect(keywords).toContain('认证');
      expect(keywords).toContain('功能');
    });

    it('should filter out stop words', () => {
      const extractKeywords = (service as unknown as { extractKeywords: (s: string) => string[] }).extractKeywords;

      const keywords = extractKeywords('这是一个的测试用例');
      expect(keywords).not.toContain('这是');
      expect(keywords).not.toContain('一个');
    });
  });
});
