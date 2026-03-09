/**
 * Tests for Task Summary Service.
 *
 * Issue #1234: Task ETA Prediction System
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskSummaryService, type SummaryReport } from './task-summary-service.js';
import { taskHistoryStorage, type TaskRecord, type TaskTypeStats } from './task-history.js';

// Mock taskHistoryStorage
vi.mock('./task-history.js', () => ({
  taskHistoryStorage: {
    getReliableTaskTypes: vi.fn(),
    getSimilarTasks: vi.fn(),
    getTaskTypeStats: vi.fn(),
    getStats: vi.fn(),
    initialize: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

describe('TaskSummaryService', () => {
  let service: TaskSummaryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TaskSummaryService();
  });

  describe('generateSummary', () => {
    it('should generate summary with task type analysis', async () => {
      // Mock data
      vi.mocked(taskHistoryStorage.getReliableTaskTypes).mockResolvedValue(['refactoring', 'bugfix']);
      vi.mocked(taskHistoryStorage.getStats).mockReturnValue({
        historyCount: 20,
        statsCount: 2,
      });

      const mockRefactoringTasks: TaskRecord[] = [
        createMockTask('refactoring', 180),
        createMockTask('refactoring', 200),
        createMockTask('refactoring', 160),
      ];

      const mockBugfixTasks: TaskRecord[] = [
        createMockTask('bugfix', 90),
        createMockTask('bugfix', 100),
        createMockTask('bugfix', 80),
      ];

      vi.mocked(taskHistoryStorage.getSimilarTasks)
        .mockImplementation(async (taskType: string) => {
          if (taskType === 'refactoring') return mockRefactoringTasks;
          if (taskType === 'bugfix') return mockBugfixTasks;
          return [];
        });

      vi.mocked(taskHistoryStorage.getTaskTypeStats)
        .mockImplementation(async (taskType: string) => {
          if (taskType === 'refactoring') {
            return {
              taskType: 'refactoring',
              sampleCount: 3,
              avgDuration: 180,
              avgErrorRatio: 1.0,
              lastUpdated: Date.now(),
            };
          }
          if (taskType === 'bugfix') {
            return {
              taskType: 'bugfix',
              sampleCount: 3,
              avgDuration: 90,
              avgErrorRatio: 0.9,
              lastUpdated: Date.now(),
            };
          }
          return undefined;
        });

      const report = await service.generateSummary();

      expect(report.totalTasks).toBe(20);
      expect(report.taskTypeSummaries).toHaveLength(2);
      expect(report.insights.length).toBeGreaterThan(0);
    });

    it('should handle no reliable task types', async () => {
      vi.mocked(taskHistoryStorage.getReliableTaskTypes).mockResolvedValue([]);
      vi.mocked(taskHistoryStorage.getStats).mockReturnValue({
        historyCount: 0,
        statsCount: 0,
      });

      const report = await service.generateSummary();

      expect(report.totalTasks).toBe(0);
      expect(report.taskTypeSummaries).toHaveLength(0);
      expect(report.insights).toContain('尚无足够的任务数据进行分析');
    });

    it('should identify patterns correctly', async () => {
      vi.mocked(taskHistoryStorage.getReliableTaskTypes).mockResolvedValue(['testing']);
      vi.mocked(taskHistoryStorage.getStats).mockReturnValue({
        historyCount: 10,
        statsCount: 1,
      });

      // Tasks with high estimation (overestimation)
      const overestimatedTasks: TaskRecord[] = [
        createMockTask('testing', 60, 200), // actual 60, estimated 200
        createMockTask('testing', 70, 200),
        createMockTask('testing', 50, 200),
        createMockTask('testing', 80, 200),
      ];

      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue(overestimatedTasks);
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue({
        taskType: 'testing',
        sampleCount: 4,
        avgDuration: 65,
        avgErrorRatio: 0.3, // Low ratio = overestimation
        lastUpdated: Date.now(),
      });

      const report = await service.generateSummary();
      const testingSummary = report.taskTypeSummaries.find(s => s.taskType === 'testing');

      expect(testingSummary).toBeDefined();
      expect(testingSummary?.patterns).toContain('普遍高估时间');
    });
  });

  describe('getRecommendations', () => {
    it('should return recommendations for a task type', async () => {
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue([
        createMockTask('refactoring', 180),
        createMockTask('refactoring', 200),
        createMockTask('refactoring', 160),
      ]);
      vi.mocked(taskHistoryStorage.getTaskTypeStats).mockResolvedValue({
        taskType: 'refactoring',
        sampleCount: 3,
        avgDuration: 180,
        avgErrorRatio: 0.5,
        lastUpdated: Date.now(),
      });

      const recommendations = await service.getRecommendations('refactoring');

      expect(recommendations.length).toBeGreaterThan(0);
    });

    it('should return default message when no data', async () => {
      vi.mocked(taskHistoryStorage.getSimilarTasks).mockResolvedValue([]);

      const recommendations = await service.getRecommendations('unknown');

      expect(recommendations).toContain('暂无足够数据提供建议');
    });
  });

  describe('formatReport', () => {
    it('should format report as markdown', () => {
      const report: SummaryReport = {
        generatedAt: '2024-01-01T00:00:00Z',
        totalTasks: 10,
        dateRange: {
          from: '2024-01-01T00:00:00Z',
          to: '2024-01-02T00:00:00Z',
        },
        taskTypeSummaries: [
          {
            taskType: 'refactoring',
            taskCount: 5,
            avgDuration: 180,
            minDuration: 120,
            maxDuration: 240,
            estimationAccuracy: 0.85,
            patterns: ['任务时间稳定，容易预测'],
            recommendations: ['继续收集数据以优化预测'],
          },
        ],
        overallRecommendations: ['建议继续收集数据'],
        insights: ['预测最准确的任务类型: refactoring (85%)'],
      };

      const formatted = service.formatReport(report);

      expect(formatted).toContain('# 任务执行总结报告');
      expect(formatted).toContain('refactoring');
      expect(formatted).toContain('3 分钟');
      expect(formatted).toContain('85%');
      expect(formatted).toContain('任务时间稳定，容易预测');
    });
  });
});

// Helper function to create mock task
function createMockTask(
  taskType: string,
  actualSeconds: number,
  estimatedSeconds: number = actualSeconds
): TaskRecord {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    chatId: 'test-chat',
    userMessage: `Test ${taskType} task`,
    taskType,
    complexityScore: 5,
    estimatedSeconds,
    actualSeconds,
    success: true,
    startedAt: Date.now() - actualSeconds * 1000,
    completedAt: Date.now(),
    keyFactors: [],
  };
}
