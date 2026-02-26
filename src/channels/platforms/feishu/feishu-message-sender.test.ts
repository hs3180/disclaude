/**
 * Tests for FeishuMessageSender.
 *
 * Tests the message sending functionality for Feishu platform:
 * - Text message sending
 * - Card message sending
 * - File message sending
 * - Reaction handling
 * - Thread reply support
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuMessageSender } from './feishu-message-sender.js';
import type { Logger } from 'pino';

// Mock lark client
const mockClient = {
  im: {
    message: {
      create: vi.fn(),
    },
    messageReaction: {
      create: vi.fn(),
    },
  },
};

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => mockClient),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('../../../utils/error-handler.js', () => ({
  handleError: vi.fn(),
  ErrorCategory: {
    API: 'api',
  },
}));

vi.mock('./card-builders/content-builder.js', () => ({
  buildTextContent: vi.fn((text) => JSON.stringify({ text })),
}));

vi.mock('../../../feishu/message-logger.js', () => ({
  messageLogger: {
    logOutgoingMessage: vi.fn(),
  },
}));

vi.mock('../../../feishu/file-uploader.js', () => ({
  uploadAndSendFile: vi.fn(),
}));

describe('FeishuMessageSender', () => {
  let sender: FeishuMessageSender;

  beforeEach(() => {
    vi.clearAllMocks();

    sender = new FeishuMessageSender({
      client: mockClient as any,
      logger: mockLogger as unknown as Logger,
    });
  });

  describe('sendText', () => {
    it('should send text message successfully', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { message_id: 'msg_123' },
      });

      await sender.sendText('chat_456', 'Hello World');

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_456',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello World' }),
        },
      });
    });

    it('should send text message with thread reply', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { message_id: 'msg_123' },
      });

      await sender.sendText('chat_456', 'Reply text', 'thread_789');

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_456',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Reply text' }),
          parent_id: 'thread_789',
        },
      });
    });

    it('should handle send error gracefully', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockRejectedValue(new Error('API error'));

      // Should not throw
      await sender.sendText('chat_456', 'Test message');

      const { handleError } = await import('../../../utils/error-handler.js');
      expect(handleError).toHaveBeenCalled();
    });

    it('should log outgoing message with bot message id', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { message_id: 'bot_msg_123' },
      });

      await sender.sendText('chat_456', 'Test');

      const { messageLogger } = await import('../../../feishu/message-logger.js');
      expect(messageLogger.logOutgoingMessage).toHaveBeenCalledWith(
        'bot_msg_123',
        'chat_456',
        'Test'
      );
    });
  });

  describe('sendCard', () => {
    it('should send card message successfully', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { message_id: 'card_msg_123' },
      });

      const card = { type: 'template', data: { text: 'Card content' } };
      await sender.sendCard('chat_456', card, 'Test card');

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_456',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    });

    it('should send card with thread reply', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { message_id: 'card_msg_123' },
      });

      const card = { type: 'template' };
      await sender.sendCard('chat_456', card, 'Card', 'thread_789');

      const callData = mockCreate.mock.calls[0][0].data;
      expect(callData.parent_id).toBe('thread_789');
    });

    it('should handle card send error gracefully', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockRejectedValue(new Error('Card API error'));

      // Should not throw
      await sender.sendCard('chat_456', { type: 'test' }, 'Test');

      const { handleError } = await import('../../../utils/error-handler.js');
      expect(handleError).toHaveBeenCalled();
    });

    it('should work without description', async () => {
      const mockCreate = mockClient.im.message.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { message_id: 'card_msg_123' },
      });

      await sender.sendCard('chat_456', { type: 'template' });

      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe('sendFile', () => {
    it('should send file successfully', async () => {
      const { uploadAndSendFile } = await import('../../../feishu/file-uploader.js');
      const mockUpload = uploadAndSendFile as ReturnType<typeof vi.fn>;
      mockUpload.mockResolvedValue(1024);

      await sender.sendFile('chat_456', '/tmp/test.pdf');

      expect(mockUpload).toHaveBeenCalledWith(
        mockClient,
        '/tmp/test.pdf',
        'chat_456',
        undefined
      );
    });

    it('should send file with thread reply', async () => {
      const { uploadAndSendFile } = await import('../../../feishu/file-uploader.js');
      const mockUpload = uploadAndSendFile as ReturnType<typeof vi.fn>;
      mockUpload.mockResolvedValue(2048);

      await sender.sendFile('chat_456', '/tmp/doc.pdf', 'thread_789');

      expect(mockUpload).toHaveBeenCalledWith(
        mockClient,
        '/tmp/doc.pdf',
        'chat_456',
        'thread_789'
      );
    });

    it('should handle file send error gracefully', async () => {
      const { uploadAndSendFile } = await import('../../../feishu/file-uploader.js');
      const mockUpload = uploadAndSendFile as ReturnType<typeof vi.fn>;
      mockUpload.mockRejectedValue(new Error('Upload failed'));

      // Should not throw
      await sender.sendFile('chat_456', '/tmp/test.pdf');

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log outgoing file message', async () => {
      const { uploadAndSendFile } = await import('../../../feishu/file-uploader.js');
      const mockUpload = uploadAndSendFile as ReturnType<typeof vi.fn>;
      mockUpload.mockResolvedValue(5120);

      const { messageLogger } = await import('../../../feishu/message-logger.js');

      await sender.sendFile('chat_456', '/path/to/document.pdf');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat_456',
          filePath: '/path/to/document.pdf',
          fileSize: 5120,
        }),
        'File sent to user'
      );
    });
  });

  describe('addReaction', () => {
    it('should add reaction successfully', async () => {
      const mockCreate = mockClient.im.messageReaction.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({});

      const result = await sender.addReaction('msg_123', 'THUMBSUP');

      expect(result).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith({
        path: { message_id: 'msg_123' },
        data: {
          reaction_type: { emoji_type: 'THUMBSUP' },
        },
      });
    });

    it('should return false on reaction error', async () => {
      const mockCreate = mockClient.im.messageReaction.create as ReturnType<typeof vi.fn>;
      mockCreate.mockRejectedValue(new Error('Reaction failed'));

      const result = await sender.addReaction('msg_123', 'THUMBSUP');

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
