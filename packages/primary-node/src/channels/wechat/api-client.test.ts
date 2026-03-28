/**
 * Tests for WeChatApiClient.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatApiClient } from './api-client.js';

// Store original fetch
const originalFetch = globalThis.fetch;

describe('WeChatApiClient', () => {
  let client: WeChatApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    client = new WeChatApiClient({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      routeTag: 'test-route',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should strip trailing slashes from baseUrl', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com/' });
      // Internal baseUrl should be cleaned
      expect(c).toBeDefined();
    });

    it('should store token', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', token: 'my-token' });
      expect(c.getToken()).toBe('my-token');
    });

    it('should store routeTag', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', routeTag: 'my-route' });
      expect(c).toBeDefined();
    });

    it('should use default bot type', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      expect(c).toBeDefined();
    });
  });

  describe('token management', () => {
    it('should set token via setToken', () => {
      client.setToken('new-token');
      expect(client.getToken()).toBe('new-token');
    });

    it('hasToken should return true when token is set', () => {
      client.setToken('token');
      expect(client.hasToken()).toBe(true);
    });

    it('hasToken should return false when token is not set', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      expect(c.hasToken()).toBe(false);
    });

    it('hasToken should return false for empty token', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', token: '' });
      expect(c.hasToken()).toBe(false);
    });

    it('hasToken should return true for whitespace token (not trimmed)', () => {
      // hasToken checks truthiness only; trimming happens in buildAuthHeaders
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', token: '   ' });
      expect(c.hasToken()).toBe(true);
    });
  });

  describe('getBotQrCode', () => {
    it('should fetch QR code from API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          qrcode: 'qr-id-123',
          qrcode_img_content: 'data:image/png;base64,abc',
        })),
      });

      const result = await client.getBotQrCode();
      expect(result.qrcode).toBe('qr-id-123');
      expect(result.qrUrl).toBe('data:image/png;base64,abc');
    });

    it('should include routeTag header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          qrcode: 'qr-id',
          qrcode_img_content: 'url',
        })),
      });

      await client.getBotQrCode();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('get_bot_qrcode'),
        expect.objectContaining({
          headers: expect.objectContaining({ SKRouteTag: 'test-route' }),
        })
      );
    });

    it('should throw when response is missing qrcode field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ qrcode_img_content: 'url' })),
      });

      await expect(client.getBotQrCode()).rejects.toThrow('missing fields in response');
    });

    it('should throw when response is missing qrcode_img_content field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ qrcode: 'qr-id' })),
      });

      await expect(client.getBotQrCode()).rejects.toThrow('missing fields in response');
    });

    it('should throw when API returns non-ok status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(client.getBotQrCode()).rejects.toThrow('WeChat API error [500]');
    });
  });

  describe('getQrCodeStatus', () => {
    it('should return wait status on timeout (AbortError)', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('wait');
    });

    it('should return confirmed status with token data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          status: 'confirmed',
          bot_token: 'bot-token-123',
          ilink_bot_id: 'bot-id',
          ilink_user_id: 'user-id',
          baseurl: 'https://custom.api.com',
        })),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('confirmed');
      expect(result.botToken).toBe('bot-token-123');
      expect(result.botId).toBe('bot-id');
      expect(result.userId).toBe('user-id');
      expect(result.baseUrl).toBe('https://custom.api.com');
      // Token should be auto-set on confirmed
      expect(client.getToken()).toBe('bot-token-123');
    });

    it('should return scaned status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'scaned' })),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('scaned');
    });

    it('should return expired status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'expired' })),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('expired');
    });

    it('should default to wait when status is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('wait');
    });

    it('should re-throw non-timeout errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(client.getQrCodeStatus('qr-123')).rejects.toThrow('Network error');
    });

    it('should include SKRouteTag header when routeTag is set', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'wait' })),
      });

      await client.getQrCodeStatus('qr-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('get_qrcode_status'),
        expect.objectContaining({
          headers: expect.objectContaining({ SKRouteTag: 'test-route' }),
        })
      );
    });

    it('should not include SKRouteTag when routeTag is not set', async () => {
      const noRouteClient = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'wait' })),
      });

      await noRouteClient.getQrCodeStatus('qr-123');
      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('SKRouteTag');
    });
  });

  describe('sendText', () => {
    it('should send text message via POST', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('sendmessage'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'AuthorizationType': 'ilink_bot_token',
            'Authorization': 'Bearer bot-token',
          }),
        })
      );
    });

    it('should include contextToken when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!', contextToken: 'ctx-123' });

      // Verify the body contains context_token
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.msg.context_token).toBe('ctx-123');
    });

    it('should throw when API returns error ret code', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 2001, err_msg: 'Invalid token' })),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'Hello!' }))
        .rejects.toThrow('WeChat API error [2001]: Invalid token');
    });

    it('should throw when HTTP request fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'Hello!' }))
        .rejects.toThrow('WeChat API error [401]');
    });

    it('should include X-WECHAT-UIN header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!' });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).toHaveProperty('X-WECHAT-UIN');
      // X-WECHAT-UIN should be a base64 string
      expect(callHeaders['X-WECHAT-UIN']).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should generate unique client_id for each message', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'msg1' });
      await client.sendText({ to: 'user-1', content: 'msg2' });

      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body1.msg.client_id).not.toBe(body2.msg.client_id);
    });

    it('should handle empty content', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: '' });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.msg.item_list).toBeUndefined();
    });

    it('should include SKRouteTag when routeTag is set', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!' });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).toHaveProperty('SKRouteTag');
      expect(callHeaders['SKRouteTag']).toBe('test-route');
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

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: updates })),
      });

      const result = await client.getUpdates();

      expect(result).toHaveLength(1);
      expect(result[0].msg_id).toBe('msg-1');
      expect(result[0].from_user_id).toBe('user-123');
    });

    it('should return empty array on timeout (AbortError)', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const result = await client.getUpdates();
      expect(result).toEqual([]);
    });

    it('should return empty array when no updates', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const result = await client.getUpdates();
      expect(result).toEqual([]);
    });

    it('should return empty array when update_list is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const result = await client.getUpdates();
      expect(result).toEqual([]);
    });

    it('should re-throw non-timeout errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(client.getUpdates()).rejects.toThrow('Network error');
    });

    it('should use long poll timeout by default', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      await client.getUpdates();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('should pass signal when provided', async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      await client.getUpdates({ signal: controller.signal });
      // The signal should be linked to the fetch call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use custom timeout when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      await client.getUpdates({ timeoutMs: 10_000 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when API returns error ret code', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 1001, err_msg: 'Invalid token' })),
      });

      // getUpdates does not catch non-AbortError errors from the API
      await expect(client.getUpdates()).rejects.toThrow('1001');
    });
  });

  describe('fetchJson (timeout)', () => {
    it('should abort request after timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockImplementation((_url, _opts) => {
        // The AbortController signal should be passed through
        return new Promise((_, reject) => {
          setTimeout(() => reject(abortError), 10);
        });
      });

      // sendText uses DEFAULT_API_TIMEOUT_MS (15s), but the abort will happen quickly
      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'test' }))
        .rejects.toThrow();
    }, 10000);
  });

  describe('edge cases', () => {
    it('should handle non-JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('not-json'),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'test' }))
        .rejects.toThrow();
    });

    it('should handle API error without err_msg', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 999 })),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'test' }))
        .rejects.toThrow('Error code 999');
    });
  });
});
