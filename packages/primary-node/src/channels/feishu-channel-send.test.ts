/**
 * Tests for FeishuChannel send message functionality.
 *
 * Issue #1619: Tests for thread reply support in doSendMessage.
 * Verifies that threadId is correctly handled when sending messages
 * via the Feishu API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// Mock fs module for file message tests
const { mockStatSync, mockCreateReadStream } = vi.hoisted(() => ({
  mockStatSync: vi.fn().mockReturnValue({ size: 1024 }),
  mockCreateReadStream: vi.fn().mockReturnValue({ pipe: vi.fn(), on: vi.fn() }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      statSync: mockStatSync,
      createReadStream: mockCreateReadStream,
    },
    statSync: mockStatSync,
    createReadStream: mockCreateReadStream,
  };
});

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

  describe('reply() fallback to create()', () => {
    it('should fallback to create() when reply() throws generic error', async () => {
      const mockClient = createMockClient();
      mockClient.im.message.reply.mockRejectedValue(new Error('Parent message not found'));

      const { channel } = createTestChannel(mockClient);

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Fallback test',
        threadId: 'deleted_parent_msg',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Fallback test' }),
        },
      });
      expect(result).toBe('new_msg_123');
    });

    it('should fallback to create() when reply() returns 403 permission error', async () => {
      const mockClient = createMockClient();
      const permissionError = new Error('Permission denied');
      (permissionError as any).status = 403;
      mockClient.im.message.reply.mockRejectedValue(permissionError);

      const { channel } = createTestChannel(mockClient);

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'card',
        card: { header: { title: 'Test' }, elements: [] },
        threadId: 'forbidden_parent_msg',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalled();
      expect(result).toBe('new_msg_123');
    });

    it('should fallback to create() when reply() returns 404 not found', async () => {
      const mockClient = createMockClient();
      const notFoundError = new Error('Message not found');
      (notFoundError as any).status = 404;
      (notFoundError as any).code = 99801406;
      mockClient.im.message.reply.mockRejectedValue(notFoundError);

      const { channel } = createTestChannel(mockClient);

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Orphan reply',
        threadId: 'nonexistent_msg',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Orphan reply' }),
        },
      });
      expect(result).toBe('new_msg_123');
    });

    it('should not fallback when reply() succeeds but returns no messageId', async () => {
      const mockClient = createMockClient();
      mockClient.im.message.reply.mockResolvedValue({ data: {} }); // no message_id

      const { channel } = createTestChannel(mockClient);

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'text',
        text: 'Reply with no messageId',
        threadId: 'parent_msg_789',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalled();
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should fallback to create() for card thread reply when reply() fails', async () => {
      const mockClient = createMockClient();
      mockClient.im.message.reply.mockRejectedValue(new Error('Thread expired'));

      const { channel } = createTestChannel(mockClient);

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'card',
        card: { header: { title: 'Fallback Card' }, elements: [] },
        threadId: 'expired_thread',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'interactive',
          content: JSON.stringify({ header: { title: 'Fallback Card' }, elements: [] }),
        },
      });
      expect(result).toBe('new_msg_123');
    });
  });

  describe('file messages with thread reply', () => {
    beforeEach(() => {
      // Reset and configure fs mocks for each file test
      mockStatSync.mockReturnValue({ size: 1024 } as any);
      mockCreateReadStream.mockReturnValue({ pipe: vi.fn(), on: vi.fn() });
    });

    it('should send image as thread reply when threadId is provided', async () => {
      const { channel, mockClient } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'file',
        filePath: '/tmp/test.png',
        threadId: 'parent_msg_789',
      });

      // Should upload image first
      expect(mockClient.im.image.create).toHaveBeenCalledWith({
        data: {
          image_type: 'message',
          image: expect.any(Object),
        },
      });
      // Should send via reply, not create
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_789' },
        data: {
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_key_abc' }),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_456');
    });

    it('should send document as thread reply when threadId is provided', async () => {
      const { channel, mockClient } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'file',
        filePath: '/tmp/test.pdf',
        threadId: 'parent_msg_789',
      });

      // Should upload file first
      expect(mockClient.im.file.create).toHaveBeenCalledWith({
        data: {
          file_type: 'pdf',
          file_name: 'test.pdf',
          file: expect.any(Object),
        },
      });
      // Should send via reply, not create
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_789' },
        data: {
          msg_type: 'file',
          content: JSON.stringify({ file_key: 'file_key_def' }),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_456');
    });

    it('should send image as new message when no threadId', async () => {
      const { channel, mockClient } = createTestChannel();

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'file',
        filePath: '/tmp/test.png',
      });

      expect(mockClient.im.image.create).toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_key_abc' }),
        },
      });
      expect(result).toBe('new_msg_123');
    });

    it('should fallback to create() for file thread reply when reply() fails', async () => {
      const mockClient = createMockClient();
      mockClient.im.message.reply.mockRejectedValue(new Error('Parent message deleted'));

      const { channel } = createTestChannel(mockClient);

      const result = await (channel as any).doSendMessage({
        chatId: 'chat_abc',
        type: 'file',
        filePath: '/tmp/test.png',
        threadId: 'deleted_parent',
      });

      // Should still upload the image
      expect(mockClient.im.image.create).toHaveBeenCalled();
      // reply() should have been attempted
      expect(mockClient.im.message.reply).toHaveBeenCalled();
      // But fallback to create()
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_abc',
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_key_abc' }),
        },
      });
      expect(result).toBe('new_msg_123');
    });
  });
});
