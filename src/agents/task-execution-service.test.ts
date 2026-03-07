/**
 * Tests for TaskExecutionService.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TaskExecutionService,
  createTaskExecutionService,
  type TaskExecutionCallbacks,
} from './task-execution-service.js';

// Mock TaskComplexityAgent
vi.mock('./task-complexity-agent.js', () => ({
  TaskComplexityAgent: vi.fn().mockImplementation(() => ({
    analyze: vi.fn().mockResolvedValue({
      complexityScore: 8,
      complexityLevel: 'high',
      estimatedSteps: 5,
      estimatedSeconds: 300,
      confidence: 0.75,
      reasoning: {
        taskType: 'refactoring',
        scope: 'multiple_files',
        uncertainty: 'medium',
        dependencies: ['testing'],
        keyFactors: ['Complex task'],
      },
      recommendation: {
        shouldStartTaskAgent: true,
        reportingInterval: 60,
        message: 'Complex task detected',
      },
    }),
  })),
  createTaskComplexityAgent: vi.fn().mockImplementation(() => ({
    analyze: vi.fn().mockResolvedValue({
      complexityScore: 8,
      complexityLevel: 'high',
      estimatedSteps: 5,
      estimatedSeconds: 300,
      confidence: 0.75,
      reasoning: {
        taskType: 'refactoring',
        scope: 'multiple_files',
        uncertainty: 'medium',
        dependencies: ['testing'],
        keyFactors: ['Complex task'],
      },
      recommendation: {
        shouldStartTaskAgent: true,
        reportingInterval: 60,
        message: 'Complex task detected',
      },
    }),
  })),
}));

// Mock task-history module
vi.mock('./task-history.js', () => ({
  taskHistoryStorage: {
    initialize: vi.fn().mockResolvedValue(undefined),
    recordTask: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({ historyCount: 10, statsCount: 5 }),
    getReliableTaskTypes: vi.fn().mockResolvedValue(['refactoring', 'feature']),
  },
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn().mockReturnValue({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    }),
  },
}));

describe('TaskExecutionService', () => {
  let mockCallbacks: TaskExecutionCallbacks;
  let service: TaskExecutionService;

  beforeEach(() => {
    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      updateCard: vi.fn().mockResolvedValue(undefined),
      getCapabilities: vi.fn().mockReturnValue({
        supportedMcpTools: ['send_user_feedback', 'update_card'],
        supportsCard: true,
      }),
    };

    service = new TaskExecutionService(mockCallbacks);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('analyzeTask', () => {
    it('should analyze task complexity', async () => {
      const result = await service.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Refactor the authentication module',
      });

      expect(result.complexity).toBeDefined();
      expect(result.complexity.complexityScore).toBe(8);
    });

    it('should return progress service for complex tasks', async () => {
      const result = await service.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Refactor the authentication module',
      });

      // Default threshold is 7, mock returns score of 8
      expect(result.needsProgressTracking).toBe(true);
      expect(result.progressService).toBeDefined();
    });

    it('should store progress service for later retrieval', async () => {
      await service.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Refactor the authentication module',
      });

      const progressService = service.getProgressService('test-chat');
      expect(progressService).toBeDefined();
    });
  });

  describe('getProgressService', () => {
    it('should return undefined for unknown chat', () => {
      const result = service.getProgressService('unknown-chat');
      expect(result).toBeUndefined();
    });
  });

  describe('updateProgress', () => {
    it('should update progress for active task', async () => {
      await service.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Refactor the authentication module',
      });

      const progressService = service.getProgressService('test-chat');
      await progressService?.start({
        complexityScore: 8,
        complexityLevel: 'high',
        estimatedSteps: 5,
        estimatedSeconds: 300,
        confidence: 0.75,
        reasoning: {
          taskType: 'refactoring',
          scope: 'multiple_files',
          uncertainty: 'medium',
          dependencies: [],
          keyFactors: [],
        },
        recommendation: {
          shouldStartTaskAgent: true,
          reportingInterval: 60,
          message: '',
        },
      });

      await service.updateProgress('test-chat', 'Processing step 1', 1, 5);

      expect(mockCallbacks.sendCard).toHaveBeenCalled();
    });

    it('should not throw for unknown chat', async () => {
      await expect(
        service.updateProgress('unknown-chat', 'Processing')
      ).resolves.not.toThrow();
    });
  });

  describe('completeTask', () => {
    it('should complete task and clean up', async () => {
      const analysis = await service.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Refactor the authentication module',
      });

      await analysis.progressService?.start(analysis.complexity);

      await service.completeTask(
        'test-chat',
        true,
        'Task completed',
        {
          chatId: 'test-chat',
          messageId: 'msg-123',
          userMessage: 'Refactor the authentication module',
        },
        analysis.complexity
      );

      // Progress service should be removed
      expect(service.getProgressService('test-chat')).toBeUndefined();
    });
  });

  describe('getHistoryStats', () => {
    it('should return history statistics', async () => {
      const stats = await service.getHistoryStats();

      expect(stats).toEqual({
        historyCount: 10,
        statsCount: 5,
        reliableTaskTypes: ['refactoring', 'feature'],
      });
    });
  });

  describe('options', () => {
    it('should respect complexity threshold', async () => {
      // Create service with high threshold
      const highThresholdService = new TaskExecutionService(mockCallbacks, {
        complexityThreshold: 10, // Higher than mock score of 8
      });

      const result = await highThresholdService.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Simple task',
      });

      expect(result.needsProgressTracking).toBe(false);
    });

    it('should respect minimum estimated time', async () => {
      // Create service with high minimum time
      const highMinTimeService = new TaskExecutionService(mockCallbacks, {
        minEstimatedTimeForProgress: 600, // Higher than mock estimate of 300s
      });

      const result = await highMinTimeService.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Quick task',
      });

      expect(result.needsProgressTracking).toBe(false);
    });

    it('should disable progress reporting when configured', async () => {
      const noProgressService = new TaskExecutionService(mockCallbacks, {
        enableProgressReporting: false,
      });

      const result = await noProgressService.analyzeTask({
        chatId: 'test-chat',
        messageId: 'msg-123',
        userMessage: 'Refactor the authentication module',
      });

      expect(result.needsProgressTracking).toBe(false);
      expect(result.progressService).toBeUndefined();
    });
  });
});

describe('createTaskExecutionService', () => {
  it('should create TaskExecutionService instance', () => {
    const callbacks: TaskExecutionCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
    };
    const service = createTaskExecutionService(callbacks);
    expect(service).toBeInstanceOf(TaskExecutionService);
  });
});
