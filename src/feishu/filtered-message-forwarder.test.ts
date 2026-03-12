/**
 * Tests for FilteredMessageForwarder.
 * @see Issue #597
 * @see Issue #652 - Uses DebugGroupService for memory-based debug group
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilteredMessageForwarder, type MessageSender } from './filtered-message-forwarder.js';
import { getDebugGroupService } from '@disclaude/primary-node';
import type { FilterReason } from '../config/types.js';

describe('FilteredMessageForwarder', () => {
  let mockSender: MessageSender;
  const debugGroupService = getDebugGroupService();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    // Clear debug group before each test
    debugGroupService.clearDebugGroup();
  });

  afterEach(() => {
    // Clean up after each test
    debugGroupService.clearDebugGroup();
  });

  describe('when debug group is not set', () => {
    it('should not be configured', () => {
      const forwarder = new FilteredMessageForwarder();
      expect(forwarder.isConfigured()).toBe(false);
    });

    it('should not forward any messages', async () => {
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender(mockSender);

      await forwarder.forward({
        messageId: 'test-id',
        chatId: 'chat-1',
        content: 'test content',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(mockSender.sendText).not.toHaveBeenCalled();
    });

    it('shouldForward should return false', () => {
      const forwarder = new FilteredMessageForwarder();
      expect(forwarder.shouldForward('passive_mode')).toBe(false);
    });
  });

  describe('when debug group is set', () => {
    const debugChatId = 'oc_debug_chat_123';

    beforeEach(() => {
      debugGroupService.setDebugGroup(debugChatId, 'Test Debug Group');
    });

    it('should be configured', () => {
      const forwarder = new FilteredMessageForwarder();
      expect(forwarder.isConfigured()).toBe(true);
    });

    it('should forward all reasons', async () => {
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender(mockSender);

      const reasons: FilterReason[] = ['duplicate', 'bot', 'old', 'unsupported', 'empty', 'passive_mode'];

      for (const reason of reasons) {
        await forwarder.forward({
          messageId: `test-${reason}`,
          chatId: 'chat-1',
          content: 'test content',
          reason,
          timestamp: Date.now(),
        });
      }

      expect(mockSender.sendText).toHaveBeenCalledTimes(6);
    });

    it('should format message correctly with debug group info', async () => {
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender(mockSender);

      await forwarder.forward({
        messageId: 'msg-123',
        chatId: 'chat-456',
        userId: 'user-789',
        content: 'Hello world',
        reason: 'passive_mode',
        timestamp: 1709565600000,
      });

      expect(mockSender.sendText).toHaveBeenCalledWith(
        debugChatId,
        expect.stringContaining('🔇')
      );
      expect(mockSender.sendText).toHaveBeenCalledWith(
        debugChatId,
        expect.stringContaining('passive_mode')
      );
      expect(mockSender.sendText).toHaveBeenCalledWith(
        debugChatId,
        expect.stringContaining('Hello world')
      );
      // Should contain debug group name
      expect(mockSender.sendText).toHaveBeenCalledWith(
        debugChatId,
        expect.stringContaining('Test Debug Group')
      );
    });

    it('should truncate long content', async () => {
      const sendText = vi.fn().mockResolvedValue(undefined);
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender({ sendText });

      const longContent = 'x'.repeat(300);
      await forwarder.forward({
        messageId: 'msg-123',
        chatId: 'chat-456',
        content: longContent,
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      const [, message] = sendText.mock.calls[0] as [unknown, string];
      expect(message).toContain('...');
    });

    it('shouldForward should return true for all reasons', () => {
      const forwarder = new FilteredMessageForwarder();
      const reasons: FilterReason[] = ['duplicate', 'bot', 'old', 'unsupported', 'empty', 'passive_mode'];

      for (const reason of reasons) {
        expect(forwarder.shouldForward(reason)).toBe(true);
      }
    });

    it('should forward to the correct debug chat ID', async () => {
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender(mockSender);

      await forwarder.forward({
        messageId: 'msg-123',
        chatId: 'chat-456',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(mockSender.sendText).toHaveBeenCalledWith(
        debugChatId,
        expect.any(String)
      );
    });
  });

  describe('when debug group is changed', () => {
    it('should forward to the new debug group after change', async () => {
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender(mockSender);

      // Set first debug group
      debugGroupService.setDebugGroup('oc_first_debug', 'First Debug');

      await forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test 1',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(mockSender.sendText).toHaveBeenCalledWith(
        'oc_first_debug',
        expect.any(String)
      );

      // Change to new debug group
      debugGroupService.setDebugGroup('oc_second_debug', 'Second Debug');

      await forwarder.forward({
        messageId: 'msg-2',
        chatId: 'chat-1',
        content: 'test 2',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(mockSender.sendText).toHaveBeenCalledWith(
        'oc_second_debug',
        expect.any(String)
      );
    });

    it('should stop forwarding after debug group is cleared', async () => {
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender(mockSender);

      // Set debug group
      debugGroupService.setDebugGroup('oc_debug', 'Debug');
      debugGroupService.clearDebugGroup();

      await forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(mockSender.sendText).not.toHaveBeenCalled();
    });
  });

  describe('setMessageSender', () => {
    beforeEach(() => {
      debugGroupService.setDebugGroup('oc_debug', 'Debug');
    });

    it('should update message sender', async () => {
      const forwarder = new FilteredMessageForwarder();

      const sendText1 = vi.fn().mockResolvedValue(undefined);
      const sendText2 = vi.fn().mockResolvedValue(undefined);

      const sender1: MessageSender = { sendText: sendText1 };
      const sender2: MessageSender = { sendText: sendText2 };

      forwarder.setMessageSender(sender1);
      await forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(sendText1).toHaveBeenCalled();

      forwarder.setMessageSender(sender2);
      await forwarder.forward({
        messageId: 'msg-2',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      expect(sendText2).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      debugGroupService.setDebugGroup('oc_debug', 'Debug');
    });

    it('should handle send errors gracefully', async () => {
      const forwarder = new FilteredMessageForwarder();

      const failingSender: MessageSender = {
        sendText: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      forwarder.setMessageSender(failingSender);

      // Should not throw
      await expect(forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      })).resolves.not.toThrow();
    });

    it('should warn when MessageSender not configured', async () => {
      const forwarder = new FilteredMessageForwarder();
      // Don't set message sender

      // Should not throw and should silently skip
      await expect(forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      })).resolves.not.toThrow();
    });
  });

  describe('formatting', () => {
    beforeEach(() => {
      debugGroupService.setDebugGroup('oc_debug', 'Debug Group');
    });

    it('should use correct emoji for each reason', async () => {
      const emojiMap: Record<FilterReason, string> = {
        duplicate: '🔄',
        bot: '🤖',
        old: '⏰',
        unsupported: '❓',
        empty: '📭',
        passive_mode: '🔇',
      };

      for (const [reason, emoji] of Object.entries(emojiMap)) {
        const sendText = vi.fn().mockResolvedValue(undefined);
        const forwarder = new FilteredMessageForwarder();
        forwarder.setMessageSender({ sendText });

        await forwarder.forward({
          messageId: `msg-${reason}`,
          chatId: 'chat-1',
          content: 'test',
          reason: reason as FilterReason,
          timestamp: Date.now(),
        });
        expect(sendText).toHaveBeenCalledWith(
          'oc_debug',
          expect.stringContaining(emoji)
        );
      }
    });

    it('should include debug group info in message', async () => {
      const sendText = vi.fn().mockResolvedValue(undefined);
      const forwarder = new FilteredMessageForwarder();
      forwarder.setMessageSender({ sendText });

      await forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      const [, message] = sendText.mock.calls[0] as [unknown, string];
      expect(message).toContain('调试群');
      expect(message).toContain('Debug Group');
    });
  });
});
