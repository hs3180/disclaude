/**
 * Tests for LarkClientService.
 *
 * Tests the unified Lark client service:
 * - Service initialization
 * - Message sending (text, card)
 * - File upload
 * - Bot info retrieval
 * - Global service management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock definitions
const mockClient = vi.hoisted(() => ({
  im: {
    message: {
      create: vi.fn(),
    },
    image: {
      create: vi.fn(),
    },
    file: {
      create: vi.fn(),
    },
  },
  request: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

// Setup mocks before imports
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(() => mockClient),
}));

vi.mock('../platforms/feishu/card-builders/content-builder.js', () => ({
  buildTextContent: vi.fn((text: string) => JSON.stringify({ text })),
}));

vi.mock('../feishu/message-logger.js', () => ({
  messageLogger: {
    logOutgoingMessage: vi.fn(),
  },
}));

vi.mock('../utils/error-handler.js', () => ({
  handleError: vi.fn(),
  ErrorCategory: {
    API: 'api',
  },
  isRetryable: vi.fn(() => false),
}));

vi.mock('../utils/retry.js', () => ({
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../file-transfer/outbound/feishu-uploader.js', () => ({
  uploadAndSendFile: vi.fn(),
}));

// Import after mocks
import {
  LarkClientService,
  initLarkClientService,
  getLarkClientService,
  isLarkClientServiceInitialized,
  resetLarkClientService,
} from './index.js';

describe('LarkClientService', () => {
  let service: LarkClientService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetLarkClientService();

    service = new LarkClientService({
      appId: 'test_app_id',
      appSecret: 'test_app_secret',
    });
  });

  afterEach(() => {
    resetLarkClientService();
  });

  describe('constructor', () => {
    it('should create service with config', () => {
      expect(service).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { appId: 'test_app_id' },
        'Initializing LarkClientService'
      );
    });

    it('should create lark client via factory', async () => {
      const { createFeishuClient } = await import('../platforms/feishu/create-feishu-client.js');
      expect(createFeishuClient).toHaveBeenCalledWith(
        'test_app_id',
        'test_app_secret',
        undefined
      );
    });
  });

  describe('getClient', () => {
    it('should return the lark client instance', () => {
      const client = service.getClient();
      expect(client).toBe(mockClient);
    });
  });

  describe('sendMessage', () => {
    it('should send text message successfully', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_123' },
      });

      await service.sendMessage('chat_456', 'Hello World');

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_456',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello World' }),
        },
      });
    });

    it('should send message with thread reply', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_123' },
      });

      await service.sendMessage('chat_456', 'Reply text', { threadId: 'thread_789' });

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
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
      mockClient.im.message.create.mockRejectedValue(new Error('API error'));

      // Should not throw
      await service.sendMessage('chat_456', 'Test message');

      const { handleError } = await import('../utils/error-handler.js');
      expect(handleError).toHaveBeenCalled();
    });

    it('should log outgoing message with bot message id', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'bot_msg_123' },
      });

      await service.sendMessage('chat_456', 'Test');

      const { messageLogger } = await import('../feishu/message-logger.js');
      expect(messageLogger.logOutgoingMessage).toHaveBeenCalledWith(
        'bot_msg_123',
        'chat_456',
        'Test'
      );
    });
  });

  describe('sendCard', () => {
    it('should send card message successfully', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'card_msg_123' },
      });

      const card = { type: 'template', data: { text: 'Card content' } };
      await service.sendCard('chat_456', card, { description: 'Test card' });

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_456',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    });

    it('should send card with thread reply', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'card_msg_123' },
      });

      const card = { type: 'template' };
      await service.sendCard('chat_456', card, { threadId: 'thread_789' });

      const callData = mockClient.im.message.create.mock.calls[0][0].data;
      expect(callData.parent_id).toBe('thread_789');
    });

    it('should handle card send error gracefully', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('Card API error'));

      // Should not throw
      await service.sendCard('chat_456', { type: 'test' }, { description: 'Test' });

      const { handleError } = await import('../utils/error-handler.js');
      expect(handleError).toHaveBeenCalled();
    });

    it('should work without description', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'card_msg_123' },
      });

      await service.sendCard('chat_456', { type: 'template' });

      expect(mockClient.im.message.create).toHaveBeenCalled();
    });
  });

  describe('uploadFile', () => {
    it('should upload and send file successfully', async () => {
      const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');
      (uploadAndSendFile as ReturnType<typeof vi.fn>).mockResolvedValue(1024);

      const result = await service.uploadFile('chat_456', '/tmp/test.pdf');

      expect(uploadAndSendFile).toHaveBeenCalledWith(
        mockClient,
        '/tmp/test.pdf',
        'chat_456',
        undefined
      );
      expect(result.fileName).toBe('test.pdf');
      expect(result.fileSize).toBe(1024);
    });

    it('should upload file with thread reply', async () => {
      const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');
      (uploadAndSendFile as ReturnType<typeof vi.fn>).mockResolvedValue(2048);

      await service.uploadFile('chat_456', '/tmp/doc.pdf', { threadId: 'thread_789' });

      expect(uploadAndSendFile).toHaveBeenCalledWith(
        mockClient,
        '/tmp/doc.pdf',
        'chat_456',
        'thread_789'
      );
    });

    it('should handle upload error', async () => {
      const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');
      (uploadAndSendFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Upload failed'));

      await expect(service.uploadFile('chat_456', '/tmp/test.pdf')).rejects.toThrow('Upload failed');
    });
  });

  describe('getBotInfo', () => {
    it('should return cached bot info on subsequent calls', async () => {
      mockClient.request.mockResolvedValue({
        data: {
          bot: {
            open_id: 'bot_open_id',
            app_id: 'bot_app_id',
            app_name: 'Test Bot',
          },
        },
      });

      const info1 = await service.getBotInfo();
      const info2 = await service.getBotInfo();

      // Should only call API once (caching)
      expect(mockClient.request).toHaveBeenCalledTimes(1);
      expect(info1).toBe(info2);
      expect(info1.openId).toBe('bot_open_id');
      expect(info1.name).toBe('Test Bot');
    });
  });
});

describe('Global Service Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLarkClientService();
  });

  afterEach(() => {
    resetLarkClientService();
  });

  describe('initLarkClientService', () => {
    it('should initialize global service', () => {
      initLarkClientService({
        appId: 'global_app_id',
        appSecret: 'global_app_secret',
      });

      expect(isLarkClientServiceInitialized()).toBe(true);
    });

    it('should log warning when reinitializing', () => {
      initLarkClientService({
        appId: 'app_id_1',
        appSecret: 'secret_1',
      });

      initLarkClientService({
        appId: 'app_id_2',
        appSecret: 'secret_2',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'LarkClientService already initialized, reinitializing...'
      );
    });
  });

  describe('getLarkClientService', () => {
    it('should return initialized service', () => {
      initLarkClientService({
        appId: 'test_app_id',
        appSecret: 'test_app_secret',
      });

      const service = getLarkClientService();
      expect(service).toBeInstanceOf(LarkClientService);
    });

    it('should throw error when not initialized', () => {
      expect(() => getLarkClientService()).toThrow(
        'LarkClientService not initialized. Call initLarkClientService first.'
      );
    });
  });

  describe('isLarkClientServiceInitialized', () => {
    it('should return false before initialization', () => {
      expect(isLarkClientServiceInitialized()).toBe(false);
    });

    it('should return true after initialization', () => {
      initLarkClientService({
        appId: 'test_app_id',
        appSecret: 'test_app_secret',
      });

      expect(isLarkClientServiceInitialized()).toBe(true);
    });

    it('should return false after reset', () => {
      initLarkClientService({
        appId: 'test_app_id',
        appSecret: 'test_app_secret',
      });

      resetLarkClientService();

      expect(isLarkClientServiceInitialized()).toBe(false);
    });
  });

  describe('resetLarkClientService', () => {
    it('should reset global service', () => {
      initLarkClientService({
        appId: 'test_app_id',
        appSecret: 'test_app_secret',
      });

      expect(isLarkClientServiceInitialized()).toBe(true);

      resetLarkClientService();

      expect(isLarkClientServiceInitialized()).toBe(false);
    });
  });
});
