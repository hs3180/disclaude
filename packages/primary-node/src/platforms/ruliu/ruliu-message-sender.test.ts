/**
 * Tests for Ruliu Message Sender.
 *
 * @see ruliu-message-sender.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuliuMessageSender } from './ruliu-message-sender.js';
import type { RuliuConfig } from './types.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  handleError: vi.fn(),
  ErrorCategory: { API: 'api' },
  retry: vi.fn((_fn) => _fn()),
}));

const testConfig: RuliuConfig = {
  apiHost: 'https://api.test.com',
  checkToken: 'test-token',
  encodingAESKey: 'test-key',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
};

function createSender(): RuliuMessageSender {
  return new RuliuMessageSender({ config: testConfig });
}

describe('RuliuMessageSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendText', () => {
    it('should get access token and send text message', async () => {
      const sender = createSender();

      // Mock token response
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'test_token', expires_in: 7200 },
          }),
        })
        // Mock message send response
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
          }),
        });

      vi.stubGlobal('fetch', mockFetch);

      await sender.sendText('chat_123', 'Hello World');

      // First call should be for token
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://api.test.com/api/robot/v1/auth/token',
        expect.objectContaining({ method: 'POST' })
      );

      // Second call should be for sending message
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.test.com/api/robot/v1/message/send',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test_token',
          }),
        })
      );

      // Verify message body
      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body).toEqual({
        chat_id: 'chat_123',
        body: [{ type: 'TEXT', content: 'Hello World' }],
      });
    });

    it('should include threadId as parent_id when provided', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'token', expires_in: 7200 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      await sender.sendText('chat_123', 'Reply', 'thread_456');

      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body.parent_id).toBe('thread_456');
    });
  });

  describe('sendCard', () => {
    it('should convert card to markdown', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'token', expires_in: 7200 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      const card = {
        header: { title: { content: 'Card Title' } },
        elements: [
          { tag: 'markdown', content: '**Bold text**' },
          { tag: 'hr' },
          { tag: 'div', text: { content: 'Plain text' } },
        ],
      };

      await sender.sendCard('chat_123', card, 'Description');

      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body.body[0].type).toBe('MD');

      const markdown = body.body[0].content;
      expect(markdown).toContain('## Description');
      expect(markdown).toContain('### Card Title');
      expect(markdown).toContain('**Bold text**');
      expect(markdown).toContain('---');
      expect(markdown).toContain('Plain text');
    });

    it('should fallback to JSON when no markdown extracted', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'token', expires_in: 7200 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      // Empty card with no extractable content
      const card = { unknown: 'field' };

      await sender.sendCard('chat_123', card);

      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body.body[0].type).toBe('MD');
      expect(body.body[0].content).toContain('```json');
    });

    it('should handle card without description', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'token', expires_in: 7200 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      const card = {
        elements: [{ tag: 'markdown', content: 'content' }],
      };

      await sender.sendCard('chat_123', card);

      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body.body[0].content).not.toContain('## undefined');
    });
  });

  describe('sendFile', () => {
    it('should send text fallback with file name', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'token', expires_in: 7200 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      await sender.sendFile('chat_123', '/path/to/document.pdf');

      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body.body[0].content).toContain('document.pdf');
      expect(body.body[0].content).toContain('[File attachment:');
    });

    it('should extract filename from path correctly', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'token', expires_in: 7200 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      await sender.sendFile('chat_123', '/a/b/c/test.png');

      const [, sendArgs] = mockFetch.mock.calls;
      const body = JSON.parse(sendArgs[1].body);
      expect(body.body[0].content).toContain('test.png');
    });
  });

  describe('addReaction', () => {
    it('should return false (not supported)', async () => {
      const sender = createSender();
      const result = await sender.addReaction('msg_123', '👍');
      expect(result).toBe(false);
    });
  });

  describe('token caching', () => {
    it('should cache token and not request again', async () => {
      const sender = createSender();

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            errcode: 0,
            errmsg: 'ok',
            data: { access_token: 'cached_token', expires_in: 7200 },
          }),
        })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ errcode: 0, errmsg: 'ok' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      // First call - should request token
      await sender.sendText('chat_1', 'msg1');
      // Second call - should use cached token
      await sender.sendText('chat_1', 'msg2');

      // Only one token request should have been made
      const tokenCalls = mockFetch.mock.calls.filter(
        (call: any[]) => call[0].includes('/auth/token')
      );
      expect(tokenCalls).toHaveLength(1);
    });

    it('should throw on HTTP error during token request', async () => {
      const sender = createSender();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      vi.stubGlobal('fetch', mockFetch);

      await expect(sender.sendText('chat_1', 'msg')).rejects.toThrow('HTTP 401');
    });

    it('should throw on API error during token request', async () => {
      const sender = createSender();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          errcode: 40001,
          errmsg: 'invalid credentials',
        }),
      });

      vi.stubGlobal('fetch', mockFetch);

      await expect(sender.sendText('chat_1', 'msg')).rejects.toThrow('API error 40001');
    });

    it('should throw when API response missing data field', async () => {
      const sender = createSender();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          errcode: 0,
          errmsg: 'ok',
          // data is missing
        }),
      });

      vi.stubGlobal('fetch', mockFetch);

      await expect(sender.sendText('chat_1', 'msg')).rejects.toThrow('missing data field');
    });
  });
});
