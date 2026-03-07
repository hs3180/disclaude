/**
 * Tests for TaskProgressService.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskProgressService, createTaskProgressService } from './task-progress-service.js';
import type { TaskComplexityResult } from './task-complexity-agent.js';

// Mock task-history module
vi.mock('./task-history.js', () => ({
  taskHistoryStorage: {
    recordTask: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('TaskProgressService', () => {
  let mockSendCard: ReturnType<typeof vi.fn>;
  let mockUpdateCard: ReturnType<typeof vi.fn>;
  let service: TaskProgressService;

  const defaultConfig = {
    chatId: 'test-chat',
    taskDescription: 'Test task',
    estimatedSeconds: 300, // 5 minutes
    sendCard: vi.fn().mockResolvedValue(undefined),
    updateCard: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendCard = vi.fn().mockResolvedValue(undefined);
    mockUpdateCard = vi.fn().mockResolvedValue(undefined);
    service = createTaskProgressService({
      ...defaultConfig,
      sendCard: mockSendCard,
      updateCard: mockUpdateCard,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const mockComplexity: TaskComplexityResult = {
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
  };

  describe('start', () => {
    it('should send initial progress card', async () => {
      await service.start(mockComplexity);

      expect(mockSendCard).toHaveBeenCalledTimes(1);
      const [chatId, card] = mockSendCard.mock.calls[0];
      expect(chatId).toBe('test-chat');
      expect(card).toHaveProperty('config');
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');
    });

    it('should include complexity info in initial card', async () => {
      await service.start(mockComplexity);

      const card = mockSendCard.mock.calls[0][1] as Record<string, unknown>;
      const elements = card.elements as Array<Record<string, unknown>>;
      const complexityElement = elements.find(
        (e) => typeof e.content === 'string' && e.content.includes('复杂度')
      );
      expect(complexityElement).toBeDefined();
    });
  });

  describe('update', () => {
    it('should send update on first call', async () => {
      await service.start(mockComplexity);
      mockSendCard.mockClear();

      await service.update('Processing step 1', 1, 5);

      expect(mockSendCard).toHaveBeenCalledTimes(1);
    });

    it('should not send update if completed', async () => {
      await service.start(mockComplexity);
      await service.complete(true);
      mockSendCard.mockClear();

      await service.update('Should not appear', 1, 5);

      expect(mockSendCard).not.toHaveBeenCalled();
    });

    it('should respect minimum update interval', async () => {
      await service.start(mockComplexity);
      await service.update('First update', 1, 5);
      mockSendCard.mockClear();

      // Advance time by 20 seconds (less than MIN_UPDATE_INTERVAL of 30s)
      vi.advanceTimersByTime(20000);
      await service.update('Second update', 2, 5);

      // Should not send update because interval hasn't passed
      expect(mockSendCard).not.toHaveBeenCalled();
    });

    it('should send update after interval passes', async () => {
      await service.start(mockComplexity);
      await service.update('First update', 1, 5);
      mockSendCard.mockClear();

      // Advance time by 31 seconds (more than MIN_UPDATE_INTERVAL of 30s)
      vi.advanceTimersByTime(31000);
      await service.update('Second update', 2, 5);

      expect(mockSendCard).toHaveBeenCalledTimes(1);
    });

    it('should always send update in early phase', async () => {
      await service.start(mockComplexity);
      await service.update('First update', 1, 5);
      mockSendCard.mockClear();

      // Advance time by 5 seconds (within EARLY_UPDATE_THRESHOLD of 10s)
      vi.advanceTimersByTime(5000);
      await service.update('Second update', 2, 5);

      expect(mockSendCard).toHaveBeenCalledTimes(1);
    });
  });

  describe('complete', () => {
    it('should send completion card on success', async () => {
      await service.start(mockComplexity);
      mockSendCard.mockClear();

      await service.complete(true, 'Task completed successfully');

      expect(mockSendCard).toHaveBeenCalledTimes(1);
      const card = mockSendCard.mock.calls[0][1] as Record<string, unknown>;
      expect(card.header).toMatchObject({
        title: { tag: 'plain_text', content: '✅ 任务完成' },
        template: 'green',
      });
    });

    it('should send failure card on error', async () => {
      await service.start(mockComplexity);
      mockSendCard.mockClear();

      await service.complete(false, 'Task failed');

      expect(mockSendCard).toHaveBeenCalledTimes(1);
      const card = mockSendCard.mock.calls[0][1] as Record<string, unknown>;
      expect(card.header).toMatchObject({
        title: { tag: 'plain_text', content: '❌ 任务失败' },
        template: 'red',
      });
    });

    it('should mark service as completed', async () => {
      await service.start(mockComplexity);
      await service.complete(true);
      mockSendCard.mockClear();

      // Try to update after completion
      await service.update('Should not appear', 1, 5);

      expect(mockSendCard).not.toHaveBeenCalled();
    });
  });

  describe('recordToHistory', () => {
    it('should record task execution to history', async () => {
      const { taskHistoryStorage } = await import('./task-history.js');

      await service.start(mockComplexity);
      vi.advanceTimersByTime(180000); // 3 minutes
      await service.recordToHistory(
        'task-123',
        'Refactor the code',
        mockComplexity,
        true
      );

      expect(taskHistoryStorage.recordTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-123',
          chatId: 'test-chat',
          userMessage: 'Refactor the code',
          taskType: 'refactoring',
          success: true,
        })
      );
    });
  });

  describe('progress bar', () => {
    it('should cap progress at 90% before completion', async () => {
      await service.start(mockComplexity);
      mockSendCard.mockClear();

      // Advance time beyond estimated time
      vi.advanceTimersByTime(400000); // More than 300s estimate
      await service.update('Still working...');

      const card = mockSendCard.mock.calls[0][1] as Record<string, unknown>;
      const elements = card.elements as Array<Record<string, unknown>>;
      const progressElement = elements.find(
        (e) => typeof e.content === 'string' && e.content.includes('进度')
      );
      expect(progressElement?.content).toContain('90%');
    });
  });
});

describe('createTaskProgressService', () => {
  it('should create TaskProgressService instance', () => {
    const service = createTaskProgressService({
      chatId: 'test',
      taskDescription: 'Test',
      estimatedSeconds: 60,
      sendCard: vi.fn(),
    });
    expect(service).toBeInstanceOf(TaskProgressService);
  });
});
