/**
 * Tests for FeishuChannel message sending with thread reply support.
 *
 * Issue #1619: doSendMessage should use reply API when threadId is provided,
 * and return the real messageId from Feishu API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// Helper to create a mock Lark client
function createMockClient() {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: 'msg_new_123' },
        }),
        reply: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

// Helper to create a FeishuChannel with mocked internals
function createTestChannel(mockClient?: any): FeishuChannel {
  const channel = new FeishuChannel({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  });

  // Inject mock client directly
  (channel as any).client = mockClient || createMockClient();

  // Mock wsConnectionManager to appear connected
  (channel as any).wsConnectionManager = {
    state: 'connected',
    isHealthy: () => true,
    getMetrics: () => ({}),
  };

  return channel;
}

describe('FeishuChannel - doSendMessage thread support (Issue #1619)', () => {
  let channel: FeishuChannel;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    channel = createTestChannel(mockClient);
  });

  describe('text messages', () => {
    it('should use create() when no threadId is provided', async () => {
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello',
      });

      expect(mockClient.im.message.create).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('msg_new_123');
    });

    it('should use reply() when threadId is provided', async () => {
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello',
        threadId: 'thread_msg_456',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'thread_msg_456' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBeUndefined(); // reply API doesn't return new messageId
    });
  });

  describe('card messages', () => {
    it('should use create() when no threadId is provided', async () => {
      const card = { header: { title: 'Test' } };
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
      });

      expect(mockClient.im.message.create).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('msg_new_123');
    });

    it('should use reply() when threadId is provided', async () => {
      const card = { header: { title: 'Test' } };
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
        threadId: 'thread_msg_789',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'thread_msg_789' },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe('messageId return value', () => {
    it('should return messageId from create API', async () => {
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Test',
      });

      expect(result).toBe('msg_new_123');
    });

    it('should return undefined when using reply API', async () => {
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Test',
        threadId: 'thread_123',
      });

      expect(result).toBeUndefined();
    });

    it('should return undefined for done signal', async () => {
      const result = await (channel as any).doSendMessage({
        chatId: 'chat_123',
        type: 'done',
      });

      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should throw error for unsupported message type', async () => {
      await expect(
        (channel as any).doSendMessage({
          chatId: 'chat_123',
          type: 'unknown',
        }),
      ).rejects.toThrow('Unsupported message type');
    });

    it('should throw error when client is not initialized', async () => {
      const channel2 = new FeishuChannel({
        appId: 'test-app-id',
        appSecret: 'test-app-secret',
      });
      // Don't inject client

      await expect(
        (channel2 as any).doSendMessage({
          chatId: 'chat_123',
          type: 'text',
          text: 'Test',
        }),
      ).rejects.toThrow('Client not initialized');
    });
  });
});
