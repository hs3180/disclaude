/**
 * Tests for Task History Storage.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskHistoryStorage, type TaskRecord } from './task-history.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TaskHistoryStorage', () => {
  let storage: TaskHistoryStorage;
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `task-history-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create storage with test directory
    storage = new TaskHistoryStorage();
    // Override data directory for testing
    (storage as unknown as { dataDir: string }).dataDir = testDir;
    (storage as unknown as { historyFile: string }).historyFile = join(testDir, 'history.json');
    (storage as unknown as { statsFile: string }).statsFile = join(testDir, 'stats.json');

    await storage.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create empty storage when no existing data', async () => {
      const stats = storage.getStats();
      expect(stats.historyCount).toBe(0);
      expect(stats.statsCount).toBe(0);
    });

    it('should load existing history', async () => {
      // Record a task
      await storage.recordTask({
        taskId: 'test-1',
        chatId: 'chat-1',
        userMessage: 'Test message',
        taskType: 'testing',
        complexityScore: 5,
        estimatedSeconds: 60,
        actualSeconds: 45,
        success: true,
        startedAt: Date.now() - 45000,
        completedAt: Date.now(),
        keyFactors: ['test'],
      });

      // Wait for debounced save (1 second + buffer)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Create new storage instance to test persistence
      const newStorage = new TaskHistoryStorage();
      (newStorage as unknown as { dataDir: string }).dataDir = testDir;
      (newStorage as unknown as { historyFile: string }).historyFile = join(testDir, 'history.json');
      (newStorage as unknown as { statsFile: string }).statsFile = join(testDir, 'stats.json');

      await newStorage.initialize();

      const similar = await newStorage.getSimilarTasks('testing');
      expect(similar.length).toBe(1);
      expect(similar[0].taskId).toBe('test-1');
    });
  });

  describe('recordTask', () => {
    it('should record a task and update stats', async () => {
      const record: TaskRecord = {
        taskId: 'task-1',
        chatId: 'chat-1',
        userMessage: 'Add a new feature',
        taskType: 'feature',
        complexityScore: 7,
        estimatedSeconds: 300,
        actualSeconds: 250,
        success: true,
        startedAt: Date.now() - 250000,
        completedAt: Date.now(),
        keyFactors: ['multi-file change', 'testing required'],
      };

      await storage.recordTask(record);

      const similar = await storage.getSimilarTasks('feature');
      expect(similar.length).toBe(1);
      expect(similar[0].taskId).toBe('task-1');
    });

    it('should calculate average stats correctly', async () => {
      // Record multiple tasks
      for (let i = 1; i <= 5; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Task ${i}`,
          taskType: 'feature',
          complexityScore: 5,
          estimatedSeconds: 100,
          actualSeconds: 100 + i * 10,
          success: true,
          startedAt: Date.now() - 100000,
          completedAt: Date.now(),
          keyFactors: [],
        });
      }

      const stats = await storage.getTaskTypeStats('feature');
      expect(stats).toBeDefined();
      expect(stats?.sampleCount).toBe(5);
      expect(stats?.avgDuration).toBeGreaterThan(100);
    });
  });

  describe('getSimilarTasks', () => {
    it('should return tasks filtered by type', async () => {
      await storage.recordTask({
        taskId: 'refactor-1',
        chatId: 'chat-1',
        userMessage: 'Refactor module',
        taskType: 'refactoring',
        complexityScore: 8,
        estimatedSeconds: 600,
        actualSeconds: 500,
        success: true,
        startedAt: Date.now() - 500000,
        completedAt: Date.now(),
        keyFactors: [],
      });

      await storage.recordTask({
        taskId: 'feature-1',
        chatId: 'chat-1',
        userMessage: 'Add feature',
        taskType: 'feature',
        complexityScore: 6,
        estimatedSeconds: 300,
        actualSeconds: 250,
        success: true,
        startedAt: Date.now() - 250000,
        completedAt: Date.now(),
        keyFactors: [],
      });

      const refactorTasks = await storage.getSimilarTasks('refactoring');
      expect(refactorTasks.length).toBe(1);
      expect(refactorTasks[0].taskId).toBe('refactor-1');

      const featureTasks = await storage.getSimilarTasks('feature');
      expect(featureTasks.length).toBe(1);
      expect(featureTasks[0].taskId).toBe('feature-1');

      const bugfixTasks = await storage.getSimilarTasks('bugfix');
      expect(bugfixTasks.length).toBe(0);
    });

    it('should limit results', async () => {
      // Record 10 tasks
      for (let i = 1; i <= 10; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Task ${i}`,
          taskType: 'testing',
          complexityScore: 3,
          estimatedSeconds: 60,
          actualSeconds: 30,
          success: true,
          startedAt: Date.now() - 30000,
          completedAt: Date.now(),
          keyFactors: [],
        });
      }

      const tasks = await storage.getSimilarTasks('testing', 5);
      expect(tasks.length).toBe(5);
    });
  });

  describe('getTaskTypeStats', () => {
    it('should return undefined when not enough samples', async () => {
      // Only 2 samples (MIN_SAMPLES is 3)
      for (let i = 1; i <= 2; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Task ${i}`,
          taskType: 'new-type',
          complexityScore: 5,
          estimatedSeconds: 100,
          actualSeconds: 100,
          success: true,
          startedAt: Date.now() - 100000,
          completedAt: Date.now(),
          keyFactors: [],
        });
      }

      const stats = await storage.getTaskTypeStats('new-type');
      expect(stats).toBeUndefined();
    });

    it('should return stats when enough samples', async () => {
      // 5 samples
      for (let i = 1; i <= 5; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Task ${i}`,
          taskType: 'reliable-type',
          complexityScore: 5,
          estimatedSeconds: 100,
          actualSeconds: 100,
          success: true,
          startedAt: Date.now() - 100000,
          completedAt: Date.now(),
          keyFactors: [],
        });
      }

      const stats = await storage.getTaskTypeStats('reliable-type');
      expect(stats).toBeDefined();
      expect(stats?.sampleCount).toBe(5);
    });
  });

  describe('getHistoricalContext', () => {
    it('should return formatted context string', async () => {
      // Record enough samples for stats
      for (let i = 1; i <= 3; i++) {
        await storage.recordTask({
          taskId: `task-${i}`,
          chatId: 'chat-1',
          userMessage: `Refactor module ${i}`,
          taskType: 'refactoring',
          complexityScore: 7,
          estimatedSeconds: 300,
          actualSeconds: 250 + i * 10,
          success: true,
          startedAt: Date.now() - 300000,
          completedAt: Date.now(),
          keyFactors: [],
        });
      }

      const context = await storage.getHistoricalContext('refactoring');

      expect(context).toContain('Task Type Statistics');
      expect(context).toContain('3 samples');
      expect(context).toContain('Recent Similar Tasks');
    });

    it('should return default message when no data', async () => {
      const context = await storage.getHistoricalContext('unknown-type');
      expect(context).toContain('No historical data available');
    });
  });

  describe('clear', () => {
    it('should clear all data', async () => {
      await storage.recordTask({
        taskId: 'task-1',
        chatId: 'chat-1',
        userMessage: 'Test',
        taskType: 'test',
        complexityScore: 5,
        estimatedSeconds: 60,
        actualSeconds: 30,
        success: true,
        startedAt: Date.now() - 30000,
        completedAt: Date.now(),
        keyFactors: [],
      });

      await storage.clear();

      const stats = storage.getStats();
      expect(stats.historyCount).toBe(0);
      expect(stats.statsCount).toBe(0);
    });
  });
});
