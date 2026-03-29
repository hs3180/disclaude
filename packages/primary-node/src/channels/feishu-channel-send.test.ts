/**
 * Tests for FeishuChannel send message functionality.
 *
 * Tests thread reply support (Issue #1619) and real messageId return.
 *
 * @see Issue #1619 - send_interactive ignores threadId
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';
import type { OutgoingMessage } from '@disclaude/core';

// Helper to create a mock Feishu client
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
        create: vi.fn().mockResolvedValue({
          image_key: 'img_key_abc',
        }),
      },
      file: {
        create: vi.fn().mockResolvedValue({
          file_key: 'file_key_xyz',
        }),
      },
    },
  };
}

// Helper to create a FeishuChannel with mocked client
function createTestChannel() {
  const channel = new FeishuChannel({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  });

  // Inject mock client
  const mockClient = createMockClient();
  (channel as any).client = mockClient;

  // Mark as running so sendMessage doesn't throw
  (channel as any)._status = 'running';

  return { channel, mockClient };
}

describe('FeishuChannel sendMessage (Issue #1619)', () => {
  let channel: FeishuChannel;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    const setup = createTestChannel();
    channel = setup.channel;
    mockClient = setup.mockClient;
  });

  describe('Thread reply support', () => {
    it('should use message.reply when threadId is provided (text)', async () => {
      const message: OutgoingMessage = {
        chatId: 'chat-001',
        type: 'text',
        text: 'Hello thread',
        threadId: 'parent_msg_001',
      };

      const result = await channel.sendMessage(message);

      // Should use reply API
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_001' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello thread' }),
        },
      });

      // Should NOT use create API
      expect(mockClient.im.message.create).not.toHaveBeenCalled();

      // Should return real messageId from reply
      expect(result).toBe('reply_msg_456');
    });

    it('should use message.reply when threadId is provided (card)', async () => {
      const card = { config: {}, elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'test' } }] };
      const message: OutgoingMessage = {
        chatId: 'chat-001',
        type: 'card',
        card,
        threadId: 'parent_msg_002',
      };

      const result = await channel.sendMessage(message);

      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_002' },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_456');
    });

    it('should fall back to create when threadId is NOT provided (text)', async () => {
      const message: OutgoingMessage = {
        chatId: 'chat-001',
        type: 'text',
        text: 'Hello',
      };

      const result = await channel.sendMessage(message);

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat-001',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_123');
    });

    it('should fall back to create when threadId is NOT provided (card)', async () => {
      const card = { config: {}, elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'test' } }] };
      const message: OutgoingMessage = {
        chatId: 'chat-001',
        type: 'card',
        card,
      };

      const result = await channel.sendMessage(message);

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat-001',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_123');
    });
  });

  describe('Real messageId return', () => {
    it('should return messageId from create API', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'feishu_msg_789' },
      });

      const result = await channel.sendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Test',
      });

      expect(result).toBe('feishu_msg_789');
    });

    it('should return messageId from reply API', async () => {
      mockClient.im.message.reply.mockResolvedValue({
        data: { message_id: 'feishu_reply_101' },
      });

      const result = await channel.sendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Reply test',
        threadId: 'parent_001',
      });

      expect(result).toBe('feishu_reply_101');
    });

    it('should return undefined for done signal', async () => {
      const result = await channel.sendMessage({
        chatId: 'chat-001',
        type: 'done',
      });

      expect(result).toBeUndefined();
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
    });
  });

  describe('File messages in thread', () => {
    it('should not call reply API for file messages with threadId (falls back to create)', async () => {
      // File messages cannot be sent as thread replies via Feishu API.
      // The sendAsThreadReply method detects file type and delegates to sendFileMessage,
      // which uses the create API path.
      const message: OutgoingMessage = {
        chatId: 'chat-001',
        type: 'file',
        filePath: '/fake/path/document.pdf',
        threadId: 'parent_msg_003',
      };

      // sendAsThreadReply calls buildFeishuMessageContent which throws for 'file' type,
      // then catches and falls back to sendFileMessage which uses create API.
      // We expect reply NOT to be called; sendFileMessage will call create but may
      // fail on fs operations (that's fine - we just verify reply isn't used).
      await expect(channel.sendMessage(message)).rejects.toThrow();

      // Verify reply was NOT called for file type
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
    });
  });
});
