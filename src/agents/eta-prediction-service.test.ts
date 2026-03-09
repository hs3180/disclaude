/**
 * Tests for ETA Prediction Service.
 *
 * Issue #1234: Task ETA Estimation System
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ETAPredictionService } from './eta-prediction-service.js';
import { TaskHistoryStorage, type TaskRecord } from './task-history.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ETAPredictionService', () => {
  let service: ETAPredictionService;
  let storage: TaskHistoryStorage;
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `eta-prediction-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create storage with test directory
    storage = new TaskHistoryStorage();
    (storage as unknown as { dataDir: string }).dataDir = testDir;
    (storage as unknown as { historyFile: string }).historyFile = join(testDir, 'history.json');
    (storage as unknown as { statsFile: string }).statsFile = join(testDir, 'stats.json');

    await storage.initialize();

    // Create service with test storage
    service = new ETAPredictionService(storage);
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('predict', () => {
    it('should return default prediction when no historical data', async () => {
      const result = await service.predict({
        userMessage: 'Add a new feature',
        taskType: 'feature',
      });

      expect(result.basedOn).toBe('default');
      expect(result.confidence).toBe(0.3);
      expect(result.estimatedSeconds).toBeGreaterThan(0);
    });

    it('should use complexity score for default prediction', async () => {
      const result = await service.predict({
        userMessage: 'Complex refactoring',
        taskType: 'refactoring',
        complexityScore: 8,
      });

      expect(result.basedOn).toBe('default');
      expect(result.estimatedSeconds).toBe(8 * 30); // 240 seconds
    });

    it('should predict from historical data when available', async () => {
      // Record enough tasks for reliable stats
      for (let i = 1; i <= 5; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Add feature ${i}`,
          taskType: 'feature',
          complexityScore: 6,
          estimatedSeconds: 200,
          actualSeconds: 180 + i * 10,
          success: true,
          startedAt: Date.now() - 200000,
          completedAt: Date.now(),
          keyFactors: ['multi-file'],
        });
      }

      const result = await service.predict({
        userMessage: 'Add a new feature',
        taskType: 'feature',
      });

      expect(result.basedOn).toBe('historical');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.debugInfo?.sampleCount).toBe(5);
    });

    it('should use similar tasks when not enough historical data', async () => {
      // Record only 2 tasks (not enough for reliable stats)
      for (let i = 1; i <= 2; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Refactor module ${i}`,
          taskType: 'refactoring',
          complexityScore: 7,
          estimatedSeconds: 300,
          actualSeconds: 250 + i * 20,
          success: true,
          startedAt: Date.now() - 300000,
          completedAt: Date.now(),
          keyFactors: [],
        });
      }

      const result = await service.predict({
        userMessage: 'Refactor another module',
        taskType: 'refactoring',
      });

      // Should use similar_tasks since not enough samples for historical
      expect(result.basedOn).toBe('similar_tasks');
      expect(result.estimatedSeconds).toBeGreaterThan(0);
    });
  });

  describe('getTaskTypeSummary', () => {
    it('should return undefined when no data', async () => {
      const summary = await service.getTaskTypeSummary('unknown-type');
      expect(summary).toBeUndefined();
    });

    it('should return summary with enough data', async () => {
      // Record enough tasks
      for (let i = 1; i <= 5; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Task ${i}`,
          taskType: 'testing',
          complexityScore: 3,
          estimatedSeconds: 60,
          actualSeconds: 45 + i * 5,
          success: true,
          startedAt: Date.now() - 60000,
          completedAt: Date.now(),
          keyFactors: ['unit-test'],
        });
      }

      const summary = await service.getTaskTypeSummary('testing');

      expect(summary).toBeDefined();
      expect(summary?.taskType).toBe('testing');
      expect(summary?.sampleCount).toBe(5);
      expect(summary?.avgDuration).toBeGreaterThan(0);
      expect(summary?.minDuration).toBe(50);
      expect(summary?.maxDuration).toBe(70);
    });

    it('should identify patterns', async () => {
      // Record tasks with common factors
      for (let i = 1; i <= 5; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Task ${i}`,
          taskType: 'feature',
          complexityScore: 6,
          estimatedSeconds: 100,
          actualSeconds: 150, // Always takes 50% longer
          success: true,
          startedAt: Date.now() - 150000,
          completedAt: Date.now(),
          keyFactors: ['database', 'api'],
        });
      }

      const summary = await service.getTaskTypeSummary('feature');

      expect(summary?.patterns.length).toBeGreaterThan(0);
      // Should detect common factors
      expect(summary?.patterns.some(p => p.includes('database') || p.includes('api'))).toBe(true);
      // Should detect estimation pattern
      expect(summary?.patterns.some(p => p.includes('longer'))).toBe(true);
    });
  });

  describe('generateExperienceReport', () => {
    it('should return message when no data', async () => {
      const report = await service.generateExperienceReport();
      expect(report).toContain('No historical data available');
    });

    it('should generate comprehensive report', async () => {
      // Record tasks for multiple types
      for (const type of ['feature', 'bugfix', 'testing']) {
        for (let i = 1; i <= 5; i++) {
          await storage.recordTask({
            taskId: `${type}-${i}`,
            chatId: 'chat-1',
            userMessage: `${type} task ${i}`,
            taskType: type,
            complexityScore: 5,
            estimatedSeconds: 100,
            actualSeconds: 90 + i * 10,
            success: true,
            startedAt: Date.now() - 100000,
            completedAt: Date.now(),
            keyFactors: [],
          });
        }
      }

      const report = await service.generateExperienceReport();

      expect(report).toContain('Task Execution Experience Report');
      expect(report).toContain('feature');
      expect(report).toContain('bugfix');
      expect(report).toContain('testing');
      expect(report).toContain('Sample Count');
      expect(report).toContain('Average Duration');
    });
  });

  describe('keyword matching', () => {
    it('should match similar task descriptions', async () => {
      // Record tasks with specific keywords
      await storage.recordTask({
        taskId: 'task-1',
        chatId: 'chat-1',
        userMessage: 'Add authentication with OAuth2',
        taskType: 'feature',
        complexityScore: 7,
        estimatedSeconds: 300,
        actualSeconds: 280,
        success: true,
        startedAt: Date.now() - 280000,
        completedAt: Date.now(),
        keyFactors: [],
      });

      await storage.recordTask({
        taskId: 'task-2',
        chatId: 'chat-1',
        userMessage: 'Implement OAuth2 login flow',
        taskType: 'feature',
        complexityScore: 7,
        estimatedSeconds: 300,
        actualSeconds: 320,
        success: true,
        startedAt: Date.now() - 320000,
        completedAt: Date.now(),
        keyFactors: [],
      });

      const result = await service.predict({
        userMessage: 'Add OAuth2 authentication support',
        taskType: 'feature',
      });

      // Should match similar tasks (OAuth2, authentication keywords)
      expect(result.basedOn).toBe('similar_tasks');
      expect(result.estimatedSeconds).toBeGreaterThan(0);
    });
  });
});
