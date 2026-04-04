/**
 * Tests for Ruliu Message Sender.
 *
 * Tests the message sending implementation for Ruliu platform,
 * including token caching, retry logic, and message formatting.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuliuMessageSender } from './ruliu-message-sender.js';
import type { RuliuConfig } from './types.js';

// Mock @disclaude/core
const mockHandleError = vi.fn();
const mockRetry = vi.fn();
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
  handleError: (...args: unknown[]) => mockHandleError(...args),
  retry: (...args: unknown[]) => mockRetry(...args),
  ErrorCategory: { API: 'api' },
}));

const mockConfig: RuliuConfig = {
  apiHost: 'https://apiin.im.baidu.com',
  checkToken: 'test-check-token',
  encodingAESKey: 'test-aes-key',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
};

describe('RuliuMessageSender', () => {
  let sender: RuliuMessageSender;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    sender = new RuliuMessageSender({ config: { ...mockConfig } });
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('sendText', () => {
    it('should send text message via API', async () => {
      // Mock token fetch
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      // Mock send fetch
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      await sender.sendText('chat-123', 'Hello, world!');

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      // First call: token
      expect((globalThis.fetch as any).mock.calls[0][0]).toContain('/auth/token');
      // Second call: send message
      expect((globalThis.fetch as any).mock.calls[1][0]).toContain('/message/send');
    });

    it('should include threadId when provided', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      await sender.sendText('chat-123', 'Reply', 'thread-456');

      // Check the send message body includes parent_id
      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.parent_id).toBe('thread-456');
    });

    it('should throw when token fetch fails with HTTP error', async () => {
      const tokenResponse = { ok: false, status: 500, statusText: 'Internal Server Error' };
      globalThis.fetch = vi.fn().mockResolvedValue(tokenResponse);

      await expect(sender.sendText('chat-123', 'Hello')).rejects.toThrow('HTTP 500');
    });

    it('should throw when token API returns error code', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({ errcode: 1001, errmsg: 'Invalid credentials' }),
      };
      globalThis.fetch = vi.fn().mockResolvedValue(tokenResponse);

      await expect(sender.sendText('chat-123', 'Hello')).rejects.toThrow('API error 1001');
    });

    it('should throw when token API response has no data', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };
      globalThis.fetch = vi.fn().mockResolvedValue(tokenResponse);

      await expect(sender.sendText('chat-123', 'Hello')).rejects.toThrow('missing data field');
    });

    it('should call handleError on send failure', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendError = new Error('Network error');
      mockRetry.mockRejectedValue(sendError);
      mockHandleError.mockImplementation(() => { throw sendError; });

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : { ok: false, status: 502, statusText: 'Bad Gateway' };
      });

      await expect(sender.sendText('chat-123', 'Hello')).rejects.toThrow('Network error');
      expect(mockHandleError).toHaveBeenCalled();
    });
  });

  describe('sendCard', () => {
    it('should convert card with header title to markdown', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      const card = {
        header: {
          title: { content: 'Card Title', tag: 'plain_text' },
        },
        elements: [
          { tag: 'markdown', content: '**Bold text**' },
          { tag: 'hr' },
        ],
      };

      await sender.sendCard('chat-123', card);

      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.body[0].type).toBe('MD');
      expect(body.body[0].content).toContain('### Card Title');
      expect(body.body[0].content).toContain('**Bold text**');
      expect(body.body[0].content).toContain('---');
    });

    it('should include description as header when provided', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      await sender.sendCard('chat-123', {}, 'My Description');

      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.body[0].content).toContain('## My Description');
    });

    it('should handle div elements with text content', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      const card = {
        elements: [
          { tag: 'div', text: { content: 'Some text' } },
        ],
      };

      await sender.sendCard('chat-123', card);

      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.body[0].content).toContain('Some text');
    });

    it('should fallback to JSON when no markdown can be extracted', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      // Card with no extractable markdown
      const card = { unknown_field: 'value' };

      await sender.sendCard('chat-123', card);

      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.body[0].content).toContain('```json');
      expect(body.body[0].content).toContain('unknown_field');
    });
  });

  describe('sendFile', () => {
    it('should send text message with file info (placeholder)', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      await sender.sendFile('chat-123', '/path/to/document.pdf');

      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.body[0].type).toBe('TEXT');
      expect(body.body[0].content).toContain('document.pdf');
      expect(body.body[0].content).toContain('File attachment');
    });

    it('should extract filename from file path', async () => {
      const tokenResponse = {
        ok: true,
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          data: { access_token: 'test-token', expires_in: 3600 },
        }),
      };
      const sendResponse = {
        ok: true,
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      };

      mockRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fetchCallCount === 1 ? tokenResponse : sendResponse;
      });

      await sender.sendFile('chat-123', '/deep/nested/path/report.xlsx');

      const sendCall = (globalThis.fetch as any).mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.body[0].content).toContain('report.xlsx');
    });
  });

  describe('addReaction', () => {
    it('should return false (not supported)', async () => {
      const result = await sender.addReaction('msg-123', '👍');
      expect(result).toBe(false);
    });

    it('should return false for any emoji', async () => {
      const result = await sender.addReaction('msg-456', '❤️');
      expect(result).toBe(false);
    });
  });
});
