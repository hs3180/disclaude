/**
 * Tests for FeedbackController.
 *
 * @see Issue #411
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeedbackController, type CardContent } from './feedback-controller.js';
import type * as lark from '@larksuiteoapi/node-sdk';

// Mock lark client
const mockClient = {
  im: {
    message: {
      create: vi.fn(),
    },
  },
} as unknown as lark.Client;

describe('FeedbackController', () => {
  let controller: FeedbackController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.im.message.create = vi.fn().mockResolvedValue({
      data: { message_id: 'test-message-id' },
    });
    controller = new FeedbackController({
      client: mockClient,
      defaultTimeout: 5000, // Short timeout for tests
    });
  });

  afterEach(() => {
    controller.dispose();
  });

  describe('createChannel', () => {
    it('should return existing chatId when type is "existing"', async () => {
      const chatId = await controller.createChannel({
        type: 'existing',
        chatId: 'oc_test_chat',
      });

      expect(chatId).toBe('oc_test_chat');
    });

    it('should throw error when chatId is missing for existing type', async () => {
      await expect(
        controller.createChannel({ type: 'existing' })
      ).rejects.toThrow('chatId is required for existing channel type');
    });

    it('should throw error for group type (not yet implemented)', async () => {
      await expect(
        controller.createChannel({ type: 'group', name: 'Test Group' })
      ).rejects.toThrow('Group channel creation requires ChatManager');
    });

    it('should throw error for private type (not yet implemented)', async () => {
      await expect(
        controller.createChannel({ type: 'private' })
      ).rejects.toThrow('Private channel creation not yet implemented');
    });
  });

  describe('sendMessage', () => {
    it('should send text message', async () => {
      await controller.sendMessage('oc_test', 'Hello World');

      expect(mockClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { receive_id_type: 'chat_id' },
          data: expect.objectContaining({
            receive_id: 'oc_test',
            msg_type: 'text',
          }),
        })
      );
    });

    it('should send card message with title and body', async () => {
      const card: CardContent = {
        title: 'Test Card',
        body: 'This is a test card',
      };

      await controller.sendMessage('oc_test', card);

      expect(mockClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { receive_id_type: 'chat_id' },
          data: expect.objectContaining({
            receive_id: 'oc_test',
            msg_type: 'interactive',
          }),
        })
      );
    });

    it('should send card with action buttons', async () => {
      const card: CardContent = {
        title: 'Confirmation',
        body: 'Do you want to proceed?',
        buttons: [
          { text: 'Yes', value: 'yes', style: 'primary' },
          { text: 'No', value: 'no', style: 'danger' },
        ],
      };

      await controller.sendMessage('oc_test', card);

      const call = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      const [[callArgs]] = call.mock.calls;
      const content = JSON.parse(callArgs.data.content);

      expect(content.config).toBeDefined();
      expect(content.header.title.content).toBe('Confirmation');
      expect(content.elements).toHaveLength(2); // div + action group
    });

    it('should send message with thread ID', async () => {
      await controller.sendMessage('oc_test', 'Reply', 'parent_msg_id');

      const call = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      const [[callArgs]] = call.mock.calls;

      expect(callArgs.data.parent_id).toBe('parent_msg_id');
    });
  });

  describe('collectFeedback - sync mode', () => {
    it('should resolve when feedback is received', async () => {
      const feedbackPromise = controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'sync',
        options: ['yes', 'no'],
        timeout: 1000,
      });

      // Simulate user response
      setTimeout(() => {
        controller.handleIncomingMessage('oc_test', 'ou_user', 'yes');
      }, 50);

      const decision = await feedbackPromise;

      expect(decision).toBeDefined();
      expect(decision!.action).toBe('yes');
      expect(decision!.confidence).toBe(1.0);
      expect(decision!.feedbacks).toHaveLength(1);
      expect(decision!.feedbacks[0].value).toBe('yes');
    });

    it('should reject on timeout', async () => {
      await expect(
        controller.collectFeedback({
          chatId: 'oc_test',
          mode: 'sync',
          options: ['yes', 'no'],
          timeout: 100, // Very short timeout
        })
      ).rejects.toThrow('Feedback collection timed out');
    });

    it('should accept freeform input when enabled', async () => {
      const feedbackPromise = controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'sync',
        freeform: true,
        timeout: 1000,
      });

      setTimeout(() => {
        controller.handleIncomingMessage('oc_test', 'ou_user', 'Any custom text');
      }, 50);

      const decision = await feedbackPromise;

      expect(decision).toBeDefined();
      expect(decision!.action).toBe('Any custom text');
      expect(decision!.feedbacks[0].type).toBe('freeform');
    });

    it('should match options case-insensitively', async () => {
      const feedbackPromise = controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'sync',
        options: ['Yes', 'No'],
        timeout: 1000,
      });

      setTimeout(() => {
        controller.handleIncomingMessage('oc_test', 'ou_user', 'YES');
      }, 50);

      const decision = await feedbackPromise;

      expect(decision).toBeDefined();
      // Case-insensitive match returns the original option value
      expect(decision!.action).toBe('Yes');
    });
  });

  describe('collectFeedback - async mode', () => {
    it('should return immediately in async mode', async () => {
      const onFeedback = vi.fn();

      const result = await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['approve', 'reject'],
        onFeedback,
      });

      expect(result).toBeUndefined();
    });

    it('should call onFeedback callback when feedback received', async () => {
      const onFeedback = vi.fn();

      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['approve', 'reject'],
        onFeedback,
      });

      // Simulate user response
      const handled = controller.handleIncomingMessage('oc_test', 'ou_user', 'approve');

      expect(handled).toBe(true);
      expect(onFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_test',
          userId: 'ou_user',
          value: 'approve',
          type: 'option',
        })
      );
    });

    it('should not remove pending after feedback in async mode', async () => {
      const onFeedback = vi.fn();

      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['a', 'b'],
        onFeedback,
      });

      controller.handleIncomingMessage('oc_test', 'ou_user', 'a');
      controller.handleIncomingMessage('oc_test', 'ou_user', 'b');

      expect(onFeedback).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleIncomingMessage', () => {
    it('should return false when no pending feedback', () => {
      const handled = controller.handleIncomingMessage('oc_test', 'ou_user', 'yes');
      expect(handled).toBe(false);
    });

    it('should return false when option does not match', async () => {
      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['yes', 'no'],
      });

      const handled = controller.handleIncomingMessage('oc_test', 'ou_user', 'maybe');
      expect(handled).toBe(false);
    });

    it('should return false for different chat', async () => {
      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['yes', 'no'],
      });

      const handled = controller.handleIncomingMessage('oc_other', 'ou_user', 'yes');
      expect(handled).toBe(false);
    });
  });

  describe('handleCardAction', () => {
    it('should handle card button action as feedback', async () => {
      const feedbackPromise = controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'sync',
        options: ['create', 'ignore'],
        timeout: 1000,
      });

      setTimeout(() => {
        controller.handleCardAction('oc_test', 'ou_user', 'create');
      }, 50);

      const decision = await feedbackPromise;
      expect(decision).toBeDefined();
      expect(decision!.action).toBe('create');
    });
  });

  describe('getPendingForChat', () => {
    it('should return pending feedback keys for chat', async () => {
      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['a', 'b'],
      });

      const pending = controller.getPendingForChat('oc_test');
      expect(pending.length).toBeGreaterThan(0);
    });

    it('should return empty array for chat with no pending', () => {
      const pending = controller.getPendingForChat('oc_nonexistent');
      expect(pending).toEqual([]);
    });
  });

  describe('cancelPending', () => {
    it('should cancel pending feedback', async () => {
      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['a', 'b'],
      });

      const pending = controller.getPendingForChat('oc_test');
      expect(pending.length).toBe(1);

      const cancelled = controller.cancelPending(pending[0]);
      expect(cancelled).toBe(true);

      const pendingAfter = controller.getPendingForChat('oc_test');
      expect(pendingAfter).toEqual([]);
    });

    it('should return false for non-existent key', () => {
      const cancelled = controller.cancelPending('non-existent-key');
      expect(cancelled).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should clear all pending feedbacks', async () => {
      await controller.collectFeedback({
        chatId: 'oc_test',
        mode: 'async',
        options: ['a', 'b'],
      });

      controller.dispose();

      const pending = controller.getPendingForChat('oc_test');
      expect(pending).toEqual([]);
    });
  });
});
