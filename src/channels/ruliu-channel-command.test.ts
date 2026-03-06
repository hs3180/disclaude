/**
 * Tests for RuliuChannel command handling.
 *
 * Issue #725 Phase 3: Command handling for /reset, /status, /help
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuliuChannel, type RuliuChannelConfig } from './ruliu-channel.js';
import type { ControlHandler, ControlResponse } from './types.js';

// Mock the RuliuMessageSender
vi.mock('../platforms/ruliu/ruliu-message-sender.js', () => ({
  RuliuMessageSender: vi.fn().mockImplementation(() => ({
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock the RuliuWebhookHandler
vi.mock('../platforms/ruliu/ruliu-webhook-handler.js', () => ({
  RuliuWebhookHandler: vi.fn().mockImplementation(() => ({
    handleUrlVerification: vi.fn().mockResolvedValue({ status: 200, body: 'success' }),
    handleWebhook: vi.fn().mockResolvedValue({ status: 200, body: 'success' }),
  })),
}));

describe('RuliuChannel Command Handling', () => {
  let channel: RuliuChannel;
  let sentMessages: Array<{ chatId: string; type: string; text?: string }>;

  const createChannel = (config: Partial<RuliuChannelConfig> = {}) => {
    const defaultConfig: RuliuChannelConfig = {
      apiHost: 'https://apiin.im.baidu.com',
      checkToken: 'test-token',
      encodingAESKey: 'test-key-12345678901234567890123456789012',
      appKey: 'test-app-key',
      appSecret: 'test-app-secret',
      robotName: 'TestBot',
      replyMode: 'mention-only',
      webhookPort: 18080,
      ...config,
    };

    channel = new RuliuChannel(defaultConfig);

    // Track sent messages
    sentMessages = [];
    channel.onMessage(async (msg) => {
      // Message handler (not used in command tests)
    });

    return channel;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (channel) {
      try {
        await channel.stop();
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  describe('Default command handling (no control handler)', () => {
    beforeEach(() => {
      createChannel();
    });

    it('should handle /reset command', async () => {
      // Intercept sendMessage
      const originalSendMessage = channel.sendMessage.bind(channel);
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      // Simulate receiving a /reset message
      const event = {
        fromuser: 'user123',
        mes: '/reset',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-1',
        timestamp: Date.now() / 1000,
      };

      // Access private method via type assertion
      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('direct_user123');
      expect(sentMessages[0].text).toContain('对话已重置');
    });

    it('should handle /status command', async () => {
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      const event = {
        fromuser: 'user123',
        mes: '/status',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-2',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('Ruliu');
      expect(sentMessages[0].text).toContain('running');
    });

    it('should handle /help command', async () => {
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      const event = {
        fromuser: 'user123',
        mes: '/help',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-3',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('可用命令');
      expect(sentMessages[0].text).toContain('/reset');
      expect(sentMessages[0].text).toContain('/status');
    });

    it('should show unknown command message for unrecognized commands', async () => {
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      const event = {
        fromuser: 'user123',
        mes: '/unknowncommand',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-4',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('未知命令');
      expect(sentMessages[0].text).toContain('/help');
    });

    it('should handle commands in group chat', async () => {
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      const event = {
        fromuser: 'user123',
        mes: '/reset',
        chatType: 'group' as const,
        groupId: 12345,
        wasMentioned: true,
        messageId: 'msg-5',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('group_12345');
    });
  });

  describe('Control handler integration', () => {
    let controlHandler: ControlHandler;

    beforeEach(() => {
      createChannel();

      // Set up control handler
      controlHandler = vi.fn(async (cmd): Promise<ControlResponse> => {
        if (cmd.type === 'reset') {
          return { success: true, message: 'Custom reset message from handler' };
        }
        if (cmd.type === 'status') {
          return { success: true, message: 'Custom status from handler' };
        }
        return { success: false, error: 'Unknown command' };
      });

      channel.onControl(controlHandler);
    });

    it('should use control handler for /reset command', async () => {
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      const event = {
        fromuser: 'user123',
        mes: '/reset',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-6',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          chatId: 'direct_user123',
        })
      );
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Custom reset message from handler');
    });

    it('should show unknown command when control handler returns failure', async () => {
      vi.spyOn(channel, 'sendMessage').mockImplementation(async (msg) => {
        sentMessages.push({ chatId: msg.chatId, type: msg.type, text: msg.text });
      });

      const event = {
        fromuser: 'user123',
        mes: '/unknowncommand',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-7',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('未知命令');
    });
  });

  describe('Non-command messages', () => {
    beforeEach(() => {
      createChannel();
    });

    it('should pass non-command messages to message handler', async () => {
      let receivedMessage: unknown = null;
      channel.onMessage(async (msg) => {
        receivedMessage = msg;
      });

      const event = {
        fromuser: 'user123',
        mes: 'Hello, how are you?',
        chatType: 'direct' as const,
        wasMentioned: true,
        messageId: 'msg-8',
        timestamp: Date.now() / 1000,
      };

      await (channel as unknown as { handleMessageEvent: (e: typeof event) => Promise<void> }).handleMessageEvent(event);

      expect(receivedMessage).not.toBeNull();
      expect((receivedMessage as { content: string }).content).toBe('Hello, how are you?');
    });
  });
});
