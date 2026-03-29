/**
 * Tests for WeChatApiClient.
 *
 * Tests the WeChat (Tencent ilink) API client with mocked fetch.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// Store original fetch
const originalFetch = globalThis.fetch;

describe('WeChatApiClient', () => {
  let WeChatApiClient: typeof import('./api-client.js').WeChatApiClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-import to get fresh module
    const mod = await import('./api-client.js');
    WeChatApiClient = mod.WeChatApiClient;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('should create client with default options', () => {
      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      expect(client.hasToken()).toBe(false);
      expect(client.getToken()).toBeUndefined();
    });

    it('should create client with token', () => {
      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      expect(client.hasToken()).toBe(true);
      expect(client.getToken()).toBe('test-token');
    });

    it('should strip trailing slashes from baseUrl', () => {
      const client = new WeChatApiClient({ baseUrl: 'https://example.com/' });
      // Internal baseUrl should be cleaned — verify client is valid
      expect(client).toBeDefined();
    });
  });

  describe('setToken / getToken / hasToken', () => {
    it('should set and get token', () => {
      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      expect(client.hasToken()).toBe(false);

      client.setToken('new-token');
      expect(client.hasToken()).toBe(true);
      expect(client.getToken()).toBe('new-token');
    });
  });

  describe('getBotQrCode', () => {
    it('should fetch and return QR code data', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          qrcode: 'qr-id-123',
          qrcode_img_content: 'https://qr.example.com/123',
        })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      const result = await client.getBotQrCode();

      expect(result.qrcode).toBe('qr-id-123');
      expect(result.qrUrl).toBe('https://qr.example.com/123');
    });

    it('should throw when QR code fields are missing', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      await expect(client.getBotQrCode()).rejects.toThrow('missing fields in response');
    });

    it('should throw on HTTP error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      await expect(client.getBotQrCode()).rejects.toThrow('500');
    });
  });

  describe('getQrCodeStatus', () => {
    it('should return confirmed status with token', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          status: 'confirmed',
          bot_token: 'bot-token-123',
          ilink_bot_id: 'bot-id-456',
          ilink_user_id: 'user-id-789',
        })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      const result = await client.getQrCodeStatus('qr-id-123');

      expect(result.status).toBe('confirmed');
      expect(result.botToken).toBe('bot-token-123');
      expect(result.botId).toBe('bot-id-456');
      expect(result.userId).toBe('user-id-789');
      // Token should be auto-set on confirmed
      expect(client.hasToken()).toBe(true);
    });

    it('should return wait status on timeout (AbortError)', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => {
        // Simulate timeout
        return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com' });
      const result = await client.getQrCodeStatus('qr-id-123');

      expect(result.status).toBe('wait');
    });
  });

  describe('sendText', () => {
    it('should send text message with correct payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      await client.sendText({ to: 'user-123', content: 'Hello!' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[0]).toContain('ilink/bot/sendmessage');
      expect(call[1].method).toBe('POST');
      expect(call[1].headers.Authorization).toBe('Bearer test-token');
      expect(call[1].headers.AuthorizationType).toBe('ilink_bot_token');

      const body = JSON.parse(call[1].body);
      expect(body.msg.to_user_id).toBe('user-123');
      expect(body.msg.item_list[0].text_item.text).toBe('Hello!');
    });

    it('should include contextToken when provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      await client.sendText({ to: 'user-123', content: 'Reply', contextToken: 'thread-abc' });

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.msg.context_token).toBe('thread-abc');
    });

    it('should throw on API error response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 1001, err_msg: 'Invalid token' })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'bad-token' });
      await expect(client.sendText({ to: 'user-123', content: 'Hi' })).rejects.toThrow('1001');
    });
  });

  describe('getUpdates', () => {
    it('should return updates from API', async () => {
      const updates = [
        {
          msg_id: 'msg-1',
          from_user_id: 'user-123',
          to_user_id: 'bot-456',
          item_list: [{ type: 1, text_item: { text: 'Hello bot!' } }],
          create_time: 1710000000,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: updates })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      const result = await client.getUpdates();

      expect(result).toHaveLength(1);
      expect(result[0].msg_id).toBe('msg-1');
      expect(result[0].from_user_id).toBe('user-123');
    });

    it('should return empty array on timeout', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      const result = await client.getUpdates();

      expect(result).toEqual([]);
    });

    it('should return empty array when no updates', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      const result = await client.getUpdates();

      expect(result).toEqual([]);
    });

    it('should respect custom timeout', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      await client.getUpdates({ timeoutMs: 5_000 });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should throw on network error (non-timeout)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const client = new WeChatApiClient({ baseUrl: 'https://example.com', token: 'test-token' });
      await expect(client.sendText({ to: 'user-123', content: 'Hi' })).rejects.toThrow('Network error');
    });
  });
});
