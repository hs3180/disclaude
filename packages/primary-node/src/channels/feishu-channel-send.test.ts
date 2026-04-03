/**
 * Tests for FeishuChannel send message functionality.
 *
 * Issue #1619: Tests for thread reply support in doSendMessage.
 * Verifies that threadId is correctly handled when sending messages
 * via the Feishu API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// ============================================================================
// Mock setup
// ============================================================================

function createMockClient() {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: 'new_msg_123' },
        }),
        reply: vi.fn().mockResolvedValue({
          data: { message_id: 'reply_msg_456' },
        }),
      },
      image: {
        create: vi.fn().mockResolvedValue({ image_key: 'img_key_abc' }),
      },
      file: {
        create: vi.fn().mockResolvedValue({ file_key: 'file_key_def' }),
      },
    },
  };
}

/**
 * Create a FeishuChannel with mocked client for testing send functionality.
 * Bypasses constructor's dependency initialization.
 */
function createTestChannel(mockClient?: ReturnType<typeof createMockClient>) {
  const client = mockClient || createMockClient();
  const channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });

  // Manually inject the mock client (bypasses doStart)
  (channel as any).client = client;

  // Mock WsConnectionManager as connected
  (channel as any).wsConnectionManager = {
    state: 'connected',
    isHealthy: () => true,
  };

  // Force channel to running state
  (channel as any)._status = 'running';

  return { channel, mockClient: client };
}

// ============================================================================
// Tests
// ============================================================================

describe('FeishuChannel doSendMessage (Issue #1619)', () => {
  describe('text messages', () => {
    it('should send text as new message when no threadId', async () => {
      const { channel, mockClient } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Hello',
      });

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_123');
    });

    it('should send text as thread reply when threadId is provided', async () => {
      const { channel, mockClient } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Reply in thread',
        threadId: 'parent_msg_789',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_789' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Reply in thread' }),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_456');
    });
  });

  describe('card messages', () => {
    it('should send card as new message when no threadId', async () => {
      const { channel, mockClient } = createTestChannel();
      const card = { header: { title: 'Test' }, elements: [] };

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'card',
        card,
      });

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_123');
    });

    it('should send card as thread reply when threadId is provided', async () => {
      const { channel, mockClient } = createTestChannel();
      const card = { header: { title: 'Test' }, elements: [] };

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'card',
        card,
        threadId: 'parent_msg_789',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_789' },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_456');
    });
  });

  describe('return value', () => {
    it('should return real messageId from API for new messages', async () => {
      const { channel } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Hello',
      });

      expect(result).toBe('new_msg_123');
    });

    it('should return real messageId from API for thread replies', async () => {
      const { channel } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Reply',
        threadId: 'parent_msg_789',
      });

      expect(result).toBe('reply_msg_456');
    });

    it('should return undefined for done signal', async () => {
      const { channel } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'done',
      });

      expect(result).toBeUndefined();
    });

    it('should return undefined when WebSocket is reconnecting (offline queue)', async () => {
      const { channel, mockClient } = createTestChannel();

      // Simulate reconnecting state
      (channel as any).wsConnectionManager.state = 'reconnecting';

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Queued message',
      });

      expect(result).toBeUndefined();
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should throw if client is not initialized', async () => {
      const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
      (channel as any).client = undefined;
      (channel as any).wsConnectionManager = { state: 'connected' };
      (channel as any)._status = 'running';

      await expect(
        (channel as any).doSendMessage({ chatId: 'chat_1', type: 'text', text: 'test' })
      ).rejects.toThrow('Client not initialized');
    });

    it('should throw for unsupported message type', async () => {
      const { channel } = createTestChannel();

      await expect(
        (channel as any).doSendMessage({ chatId: 'chat_1', type: 'unknown' })
      ).rejects.toThrow('Unsupported message type');
    });
  });
});
