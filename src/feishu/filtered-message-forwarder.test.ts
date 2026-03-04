/**
 * Tests for FilteredMessageForwarder.
 * @see Issue #597
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilteredMessageForwarder, type MessageSender } from './filtered-message-forwarder.js';
import type { FilterReason } from '../config/types.js';

describe('FilteredMessageForwarder', () => {
  let mockSender: MessageSender;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('when disabled', () => {
    it('should not be configured', () => {
      const forwarder = new FilteredMessageForwarder({ enabled: false });
      expect(forwarder.isConfigured()).toBe(false);
    });

    it('should not forward any messages', async () => {
      const forwarder = new FilteredMessageForwarder({ enabled: false });
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

    it('should not forward even if reason matches includeReasons', async () => {
      const forwarder = new FilteredMessageForwarder({
        enabled: false,
        filterForwardChatId: 'debug-chat',
        includeReasons: ['passive_mode'],
      });
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
  });

  describe('when enabled without filterForwardChatId', () => {
    it('should not be configured', () => {
      const forwarder = new FilteredMessageForwarder({ enabled: true });
      expect(forwarder.isConfigured()).toBe(false);
    });
  });

  describe('when fully configured', () => {
    it('should be configured', () => {
      const forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat-123',
      });
      expect(forwarder.isConfigured()).toBe(true);
    });

    it('should forward all reasons when includeReasons is empty', async () => {
      const forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat-123',
      });
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

    it('should format message correctly', async () => {
      const forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat-123',
      });
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
        'debug-chat-123',
        expect.stringContaining('🔇')
      );
      expect(mockSender.sendText).toHaveBeenCalledWith(
        'debug-chat-123',
        expect.stringContaining('passive_mode')
      );
      expect(mockSender.sendText).toHaveBeenCalledWith(
        'debug-chat-123',
        expect.stringContaining('Hello world')
      );
    });

    it('should truncate long content', async () => {
      const sendText = vi.fn().mockResolvedValue(undefined);
      const forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat-123',
      });
      forwarder.setMessageSender({ sendText });

      const longContent = 'x'.repeat(300);
      await forwarder.forward({
        messageId: 'msg-123',
        chatId: 'chat-456',
        content: longContent,
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      const call = sendText.mock.calls[0];
      const message = call[1] as string;
      expect(message).toContain('...');
    });
  });

  describe('when configured with includeReasons', () => {
    let forwarder: FilteredMessageForwarder;

    beforeEach(() => {
      forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat-123',
        includeReasons: ['passive_mode', 'duplicate'],
      });
      forwarder.setMessageSender(mockSender);
    });

    it('should forward only included reasons', async () => {
      await forwarder.forward({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        reason: 'passive_mode',
        timestamp: Date.now(),
      });

      await forwarder.forward({
        messageId: 'msg-2',
        chatId: 'chat-1',
        content: 'test',
        reason: 'duplicate',
        timestamp: Date.now(),
      });

      await forwarder.forward({
        messageId: 'msg-3',
        chatId: 'chat-1',
        content: 'test',
        reason: 'bot',
        timestamp: Date.now(),
      });

      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
    });

    it('should check shouldForward correctly', () => {
      expect(forwarder.shouldForward('passive_mode')).toBe(true);
      expect(forwarder.shouldForward('duplicate')).toBe(true);
      expect(forwarder.shouldForward('bot')).toBe(false);
      expect(forwarder.shouldForward('old')).toBe(false);
    });
  });

  describe('setMessageSender', () => {
    it('should update message sender', async () => {
      const forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat',
      });

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
    it('should handle send errors gracefully', async () => {
      const forwarder = new FilteredMessageForwarder({
        enabled: true,
        filterForwardChatId: 'debug-chat',
      });

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
  });

  describe('formatting', () => {
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
        const forwarder = new FilteredMessageForwarder({
          enabled: true,
          filterForwardChatId: 'debug-chat',
        });
        forwarder.setMessageSender({ sendText });

        await forwarder.forward({
          messageId: `msg-${reason}`,
          chatId: 'chat-1',
          content: 'test',
          reason: reason as FilterReason,
          timestamp: Date.now(),
        });
        expect(sendText).toHaveBeenCalledWith(
          'debug-chat',
          expect.stringContaining(emoji)
        );
      }
    });
  });
});
