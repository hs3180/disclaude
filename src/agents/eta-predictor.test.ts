/**
 * Tests for ETA Predictor.
 *
 * Issue #1234: Task ETA Prediction System
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ETAPredictor, type ETAPrediction } from './eta-predictor.js';
import { taskHistoryStorage, type TaskRecord, type TaskTypeStats } from './task-history.js';

// Mock taskHistoryStorage
vi.mock('./task-history.js', () => ({
  taskHistoryStorage: {
    getTaskTypeStats: vi.fn(),
    getSimilarTasks: vi.fn(),
    initialize: vi.fn(),
  },
}));

describe('ETAPredictor', () => {
  let predictor: ETAPredictor;

  beforeEach(() => {
    vi.clearAllMocks();
    predictor = new ETAPredictor();
  });

  describe('predictETA', () => {
    it('should return historical prediction when stats available', async () => {
      // Mock historical stats
      const mockStats: TaskTypeStats = {
        taskType: 'refactoring',
        sampleCount: 10,
        avgDuration: 180,
        avgErrorRatio: 1.1,
        lastUpdated: Date.now(),
      };
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue(mockStats);
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue([]);

      const prediction = await predictor.predictETA({
        taskType: 'refactoring',
        description: 'Refactor authentication module',
      });

      expect(prediction.basedOn).toBe('historical');
      expect(prediction.estimatedSeconds).toBe(180);
      expect(prediction.confidence).toBeGreaterThan(0);
      expect(prediction.details?.sampleCount).toBe(10);
    });

    it('should return similar tasks prediction when no stats but similar tasks exist', async () => {
      // Mock no stats but similar tasks
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue(undefined);
      // Use exact same keywords to ensure high similarity score
      const mockTasks: TaskRecord[] = [
        {
          taskId: '1',
          chatId: 'chat1',
          userMessage: 'Refactor authentication module refactor authentication module',
          taskType: 'refactoring',
          complexityScore: 7,
          estimatedSeconds: 200,
          actualSeconds: 180,
          success: true,
          startedAt: Date.now() - 10000,
          completedAt: Date.now(),
          keyFactors: [],
        },
        {
          taskId: '2',
          chatId: 'chat2',
          userMessage: 'Refactor authentication module for security',
          taskType: 'refactoring',
          complexityScore: 6,
          estimatedSeconds: 150,
          actualSeconds: 160,
          success: true,
          startedAt: Date.now() - 10000,
          completedAt: Date.now(),
          keyFactors: [],
        },
        {
          taskId: '3',
          chatId: 'chat3',
          userMessage: 'Refactor authentication module API',
          taskType: 'refactoring',
          complexityScore: 5,
          estimatedSeconds: 120,
          actualSeconds: 140,
          success: true,
          startedAt: Date.now() - 10000,
          completedAt: Date.now(),
          keyFactors: [],
        },
      ];
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue(mockTasks);

      const prediction = await predictor.predictETA({
        taskType: 'refactoring',
        description: 'Refactor authentication module',
      });

      expect(prediction.basedOn).toBe('similar_tasks');
      expect(prediction.estimatedSeconds).toBeGreaterThan(0);
      expect(prediction.confidence).toBeGreaterThan(0);
    });

    it('should return default prediction when no historical data', async () => {
      // Mock no data
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue(undefined);
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue([]);

      const prediction = await predictor.predictETA({
        taskType: 'refactoring',
        description: 'Refactor authentication module',
      });

      expect(prediction.basedOn).toBe('default');
      expect(prediction.estimatedSeconds).toBe(300); // Default for refactoring
      expect(prediction.confidence).toBe(0.2);
    });

    it('should return different defaults for different task types', async () => {
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue(undefined);
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue([]);

      const refactoringPrediction = await predictor.predictETA({
        taskType: 'refactoring',
        description: 'Refactor code',
      });

      const bugfixPrediction = await predictor.predictETA({
        taskType: 'bugfix',
        description: 'Fix bug',
      });

      const explanationPrediction = await predictor.predictETA({
        taskType: 'explanation',
        description: 'Explain code',
      });

      expect(refactoringPrediction.estimatedSeconds).toBeGreaterThan(bugfixPrediction.estimatedSeconds);
      expect(bugfixPrediction.estimatedSeconds).toBeGreaterThan(explanationPrediction.estimatedSeconds);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockRejectedValue(new Error('Storage error'));
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockRejectedValue(new Error('Storage error'));

      const prediction = await predictor.predictETA({
        taskType: 'refactoring',
        description: 'Refactor code',
      });

      expect(prediction.basedOn).toBe('default');
      expect(prediction.estimatedSeconds).toBeGreaterThan(0);
    });
  });

  describe('formatPrediction', () => {
    it('should format prediction with historical data', () => {
      const prediction: ETAPrediction = {
        estimatedSeconds: 180,
        confidence: 0.75,
        basedOn: 'historical',
        details: {
          sampleCount: 10,
          avgDuration: 180,
          taskType: 'refactoring',
        },
      };

      const formatted = predictor.formatPrediction(prediction);

      expect(formatted).toContain('3 分钟');
      expect(formatted).toContain('75%');
      expect(formatted).toContain('历史数据');
      expect(formatted).toContain('10 个样本');
    });

    it('should format prediction with default data', () => {
      const prediction: ETAPrediction = {
        estimatedSeconds: 120,
        confidence: 0.2,
        basedOn: 'default',
      };

      const formatted = predictor.formatPrediction(prediction);

      expect(formatted).toContain('2 分钟');
      expect(formatted).toContain('20%');
      expect(formatted).toContain('默认估计');
    });
  });

  describe('configuration', () => {
    it('should use custom default ETA', async () => {
      const customPredictor = new ETAPredictor({ defaultETA: 300 });
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue(undefined);
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue([]);

      const prediction = await customPredictor.predictETA({
        taskType: 'unknown_type',
        description: 'Unknown task',
      });

      expect(prediction.estimatedSeconds).toBe(300);
    });
  });
});
