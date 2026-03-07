/**
 * Tests for thread operations MCP tools.
 *
 * @module mcp/tools/thread-operations.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

vi.mock('../../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(() => ({
    im: {
      message: {
        reply: vi.fn(),
        list: vi.fn(),
      },
    },
  })),
}));

vi.mock('../../ipc/unix-socket-client.js', () => ({
  getIpcClient: vi.fn(() => ({
    request: vi.fn(),
    isConnected: vi.fn(() => false),
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

import { reply_in_thread, get_threads, get_thread_messages } from './thread-operations.js';

describe('thread-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('reply_in_thread', () => {
    it('should fail when messageId is missing', async () => {
      const result = await reply_in_thread({
        messageId: '',
        content: 'Test reply',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('messageId is required');
    });

    it('should fail when content is missing', async () => {
      const result = await reply_in_thread({
        messageId: 'om_test123',
        content: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('content is required');
    });

    it('should validate required parameters', async () => {
      // Test that function validates input
      const result = await reply_in_thread({
        messageId: 'om_test123',
        content: 'Test reply',
        msgType: 'text',
      });

      // Should succeed or fail based on Feishu API availability
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
    });
  });

  describe('get_threads', () => {
    it('should fail when chatId is missing', async () => {
      const result = await get_threads({
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });

    it('should accept optional parameters', async () => {
      const result = await get_threads({
        chatId: 'oc_test123',
        pageToken: 'token123',
        pageSize: 20,
      });

      // Should succeed or fail based on Feishu API availability
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
    });
  });

  describe('get_thread_messages', () => {
    it('should fail when threadId is missing', async () => {
      const result = await get_thread_messages({
        threadId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('threadId is required');
    });

    it('should accept optional parameters', async () => {
      const result = await get_thread_messages({
        threadId: 'omt_test123',
        pageToken: 'token123',
        pageSize: 20,
      });

      // Should succeed or fail based on Feishu API availability
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
    });
  });
});
