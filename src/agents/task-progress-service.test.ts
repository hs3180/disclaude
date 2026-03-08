/**
 * Tests for TaskProgressService.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { TaskProgressService } from './task-progress-service.js';
import type { TaskComplexityResult } from './task-complexity-agent.js';

describe('TaskProgressService', () => {
  let service: TaskProgressService;
  let mockSendCard: Mock<(card: Record<string, unknown>) => Promise<void>>;

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
      dependencies: ['file_system', 'testing'],
      keyFactors: ['Factor 1', 'Factor 2', 'Factor 3'],
    },
    recommendation: {
      shouldStartTaskAgent: true,
      reportingInterval: 60,
      message: '检测到复杂任务，已启动后台执行模式',
    },
  };

  beforeEach(() => {
    service = new TaskProgressService();
    mockSendCard = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any active tracking
    vi.clearAllMocks();
  });

  describe('startTracking', () => {
    it('should start tracking and send initial progress card', async () => {
    const taskId = await service.startTracking({
      chatId: 'test-chat-id',
      messageId: 'test-message-id',
      userMessage: 'Refactor the authentication module',
      complexity: mockComplexity,
      sendCard: mockSendCard,
      });

      expect(taskId).toBeDefined();
      expect(taskId).toMatch(/^task-test-chat-id-\d+$/);
      expect(mockSendCard).toHaveBeenCalledTimes(1);

      // Verify card structure
      const [[cardArg]] = mockSendCard.mock.calls;
      expect(cardArg).toHaveProperty('config');
      expect(cardArg).toHaveProperty('header');
      expect(cardArg).toHaveProperty('elements');
    });

    it('should track active task after starting', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      expect(service.hasActiveTask(chatId)).toBe(true);
      expect(service.getActiveTask(chatId)).toBeDefined();
    });
  });

  describe('completeTask', () => {
    it('should complete task successfully', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      // Reset mock for completion card
      mockSendCard.mockClear();

      await service.completeTask(chatId, true, 'Task completed successfully');

      expect(mockSendCard).toHaveBeenCalledTimes(1);
      expect(service.hasActiveTask(chatId)).toBe(false);
    });

    it('should complete task with failure', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      mockSendCard.mockClear();

      await service.completeTask(chatId, false, 'Task failed');

      expect(mockSendCard).toHaveBeenCalledTimes(1);
      expect(service.hasActiveTask(chatId)).toBe(false);
    });

    it('should handle completion for non-existent task', async () => {
      // Should not throw
      await expect(
        service.completeTask('non-existent-chat', true, 'Done')
      ).resolves.toBeUndefined();
    });
  });

  describe('hasActiveTask', () => {
    it('should return false when no active task', () => {
      expect(service.hasActiveTask('non-existent-chat')).toBe(false);
    });

    it('should return true when task is active', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      expect(service.hasActiveTask(chatId)).toBe(true);
    });
  });

  describe('getActiveTask', () => {
    it('should return undefined when no active task', () => {
      expect(service.getActiveTask('non-existent-chat')).toBeUndefined();
    });

    it('should return task info when task is active', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      const taskInfo = service.getActiveTask(chatId);
      expect(taskInfo).toBeDefined();
      expect(taskInfo?.taskId).toMatch(/^task-/);
      expect(taskInfo?.percent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('buildProgressCard', () => {
    it('should build card with correct structure', async () => {
      await service.startTracking({
        chatId: 'test-chat-id',
        messageId: 'test-message-id',
        userMessage: 'Task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      const [[cardArg]] = mockSendCard.mock.calls;

      // Check structure
      expect(cardArg.config).toEqual({ wide_screen_mode: true });
      expect(cardArg.header).toHaveProperty('title');
      expect(cardArg.header).toHaveProperty('template');
      expect(Array.isArray(cardArg.elements)).toBe(true);
    });

    it('should include task ID in card', async () => {
      await service.startTracking({
        chatId: 'test-chat-id',
        messageId: 'test-message-id',
        userMessage: 'Task',
        complexity: mockComplexity,
        sendCard: mockSendCard,
      });

      const cardArg = mockSendCard.mock.calls[0][0] as Record<string, unknown>;
      const elements = cardArg.elements as Array<Record<string, unknown>>;
      const [firstElement] = elements;
      expect(firstElement.content).toContain('任务ID');
    });
  });
});
