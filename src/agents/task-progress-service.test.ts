/**
 * Tests for TaskProgressService.
 *
 * Issue #857: Complex Task Auto-Start Task Agent with Progress Reporting
 * Refactored: Removed TaskComplexityAgent dependency
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { TaskProgressService } from './task-progress-service.js';

describe('TaskProgressService', () => {
  let service: TaskProgressService;
  let mockSendCard: Mock<(card: Record<string, unknown>) => Promise<void>>;

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
        sendCard: mockSendCard,
      });

      const cardArg = mockSendCard.mock.calls[0][0] as Record<string, unknown>;
      const elements = cardArg.elements as Array<Record<string, unknown>>;
      const [firstElement] = elements;
      expect(firstElement.content).toContain('任务ID');
    });
  });

  describe('updateProgressManually', () => {
    it('should update progress for active task', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Task',
        sendCard: mockSendCard,
      });

      mockSendCard.mockClear();

      await service.updateProgressManually(chatId, {
        currentStep: 'Processing files',
        percent: 50,
        message: 'Halfway done',
      });

      expect(mockSendCard).toHaveBeenCalledTimes(1);

      const taskInfo = service.getActiveTask(chatId);
      expect(taskInfo?.percent).toBe(50);
    });

    it('should not update progress for non-existent task', async () => {
      await service.updateProgressManually('non-existent-chat', {
        currentStep: 'Processing',
      });

      expect(mockSendCard).not.toHaveBeenCalled();
    });
  });

  describe('pauseTask', () => {
    it('should pause a running task', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      mockSendCard.mockClear();

      const result = await service.pauseTask(chatId);

      expect(result).toBe(true);
      expect(mockSendCard).toHaveBeenCalledTimes(1);

      const taskInfo = service.getActiveTask(chatId);
      expect(taskInfo?.status).toBe('paused');
    });

    it('should return false when no task to pause', async () => {
      const result = await service.pauseTask('non-existent-chat');
      expect(result).toBe(false);
    });

    it('should return false when task is already paused', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      await service.pauseTask(chatId);
      mockSendCard.mockClear();

      const result = await service.pauseTask(chatId);
      expect(result).toBe(false);
    });
  });

  describe('resumeTask', () => {
    it('should resume a paused task', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      await service.pauseTask(chatId);
      mockSendCard.mockClear();

      const result = await service.resumeTask(chatId);

      expect(result).toBe(true);
      expect(mockSendCard).toHaveBeenCalledTimes(1);

      const taskInfo = service.getActiveTask(chatId);
      expect(taskInfo?.status).toBe('running');
    });

    it('should return false when no task to resume', async () => {
      const result = await service.resumeTask('non-existent-chat');
      expect(result).toBe(false);
    });

    it('should return false when task is running (not paused)', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      mockSendCard.mockClear();

      const result = await service.resumeTask(chatId);
      expect(result).toBe(false);
    });
  });

  describe('cancelTask', () => {
    it('should cancel a running task', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      mockSendCard.mockClear();

      const result = await service.cancelTask(chatId);

      expect(result).toBe(true);
      expect(mockSendCard).toHaveBeenCalledTimes(1);
      expect(service.hasActiveTask(chatId)).toBe(false);
    });

    it('should cancel a paused task', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      await service.pauseTask(chatId);
      mockSendCard.mockClear();

      const result = await service.cancelTask(chatId);

      expect(result).toBe(true);
      expect(service.hasActiveTask(chatId)).toBe(false);
    });

    it('should return false when no task to cancel', async () => {
      const result = await service.cancelTask('non-existent-chat');
      expect(result).toBe(false);
    });

    it('should send cancelled card with correct status', async () => {
      const chatId = 'test-chat-id';
      await service.startTracking({
        chatId,
        messageId: 'test-message-id',
        userMessage: 'Complex task',
        sendCard: mockSendCard,
      });

      mockSendCard.mockClear();

      await service.cancelTask(chatId);

      const cardArg = mockSendCard.mock.calls[0][0] as Record<string, unknown>;
      const header = cardArg.header as Record<string, unknown>;
      expect(header.template).toBe('grey');
    });
  });
});
