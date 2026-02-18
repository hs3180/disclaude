/**
 * Tests for Feishu sender utility (src/feishu/sender.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFeishuSender, createFeishuCardSender } from './sender.js';
import * as lark from '@larksuiteoapi/node-sdk';

// Mock setup
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
  Domain: { Feishu: 'https://open.feishu.cn' },
  default: { Client: vi.fn(), Domain: { Feishu: 'https://open.feishu.cn' } },
}));

vi.mock('../config/index.js', () => ({
  Config: { FEISHU_APP_ID: 'test-app-id', FEISHU_APP_SECRET: 'test-app-secret' },
}));

vi.mock('./content-builder.js', () => ({
  buildTextContent: vi.fn((text) => JSON.stringify({ text })),
}));

import { Config } from '../config/index.js';

const mockedLarkClient = lark.Client as unknown as ReturnType<typeof vi.fn>;

interface MockClient {
  im: { message: { create: ReturnType<typeof vi.fn> } };
}

describe('Feishu Sender', () => {
  let mockClient: MockClient;
  let originalError: Console['error'];

  beforeEach(() => {
    vi.clearAllMocks();
    originalError = console.error;
    console.error = vi.fn();
    mockClient = { im: { message: { create: vi.fn().mockResolvedValue({ data: { message_id: 'msg123' } }) } } };
    mockedLarkClient.mockReturnValue(mockClient);
  });

  afterEach(() => {
    console.error = originalError;
  });

  describe('createFeishuSender', () => {
    it('should create sender function and initialize client', () => {
      const sender = createFeishuSender();
      expect(typeof sender).toBe('function');
      expect(mockedLarkClient).toHaveBeenCalledWith({
        appId: Config.FEISHU_APP_ID,
        appSecret: Config.FEISHU_APP_SECRET,
        domain: lark.Domain.Feishu,
      });
    });

    it('should send message via REST API', async () => {
      const sender = createFeishuSender();
      await sender('oc_chat123', 'Test message');

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'oc_chat123', msg_type: 'text', content: expect.any(String) },
      });
    });

    it('should handle send errors', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API error'));
      await expect(createFeishuSender()('oc_chat123', 'Test')).rejects.toThrow();
    });

    it('should handle empty and special messages', async () => {
      const sender = createFeishuSender();
      await expect(sender('oc_chat123', '')).resolves.not.toThrow();
      await expect(sender('oc_chat123', '🎉 中文')).resolves.not.toThrow();
    });
  });

  describe('createFeishuCardSender', () => {
    it('should create and send card', async () => {
      const sender = createFeishuCardSender();
      const card = { config: { wide_screen_mode: true } };
      await sender('oc_chat123', card);

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'oc_chat123', msg_type: 'interactive', content: JSON.stringify(card) },
      });
    });

    it('should handle card send errors', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('Card send failed'));
      await expect(createFeishuCardSender()('oc_chat123', { config: {} })).rejects.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should send multiple messages sequentially', async () => {
      mockClient.im.message.create
        .mockResolvedValueOnce({ data: { message_id: 'msg1' } })
        .mockResolvedValueOnce({ data: { message_id: 'msg2' } });

      const sender = createFeishuSender();
      await sender('oc_chat123', 'Message 1');
      await sender('oc_chat123', 'Message 2');

      expect(mockClient.im.message.create).toHaveBeenCalledTimes(2);
    });
  });
});
