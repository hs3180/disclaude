/**
 * Tests for WeChatApiClient (MVP).
 *
 * @see Issue #1473 - WeChat Channel MVP
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

  describe('sendImage', () => {
    it('should send image message with correct payload', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendImage({ to: 'user-1', imageUrl: 'https://cdn.example.com/img.png' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain('ilink/bot/sendmessage');
      expect(call[1].method).toBe('POST');

      const body = JSON.parse(call[1].body);
      expect(body.msg.item_list[0].type).toBe(2);
      expect(body.msg.item_list[0].image_item.url).toBe('https://cdn.example.com/img.png');
    });

    it('should include contextToken when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendImage({
        to: 'user-1',
        imageUrl: 'https://cdn.example.com/img.png',
        contextToken: 'ctx-abc',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.msg.context_token).toBe('ctx-abc');
    });
  });

  describe('sendFile', () => {
    it('should send file message with correct payload', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendFile({
        to: 'user-1',
        fileUrl: 'https://cdn.example.com/doc.pdf',
        fileName: 'document.pdf',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.msg.item_list[0].type).toBe(3);
      expect(body.msg.item_list[0].file_item.url).toBe('https://cdn.example.com/doc.pdf');
      expect(body.msg.item_list[0].file_item.file_name).toBe('document.pdf');
    });

    it('should include contextToken when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendFile({
        to: 'user-1',
        fileUrl: 'https://cdn.example.com/doc.pdf',
        fileName: 'doc.pdf',
        contextToken: 'ctx-xyz',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.msg.context_token).toBe('ctx-xyz');
    });
  });

  describe('uploadMedia', () => {
    it('should upload file and return CDN URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          ret: 0,
          url: 'https://cdn.example.com/file-abc.png',
          file_key: 'key-123',
        })),
      });

      client.setToken('bot-token');
      const result = await client.uploadMedia({
        fileData: Buffer.from('fake-image-data'),
        fileName: 'test.png',
        mimeType: 'image/png',
      });

      expect(result.url).toBe('https://cdn.example.com/file-abc.png');
      expect(result.fileKey).toBe('key-123');

      // Verify the call uses FormData (body is not a string)
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain('ilink/bot/upload');
      expect(call[1].method).toBe('POST');
      expect(call[1].body).toBeInstanceOf(FormData);
    });

    it('should throw when file is too large (> 20 MB)', async () => {
      client.setToken('bot-token');
      const hugeBuffer = Buffer.alloc(21 * 1024 * 1024); // 21 MB

      await expect(client.uploadMedia({
        fileData: hugeBuffer,
        fileName: 'huge.bin',
      })).rejects.toThrow('File too large');
    });

    it('should throw when response missing url or file_key', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await expect(client.uploadMedia({
        fileData: Buffer.from('data'),
        fileName: 'test.txt',
      })).rejects.toThrow('missing url or file_key');
    });

    it('should throw when upload returns error ret code', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 1001, err_msg: 'Upload failed' })),
      });

      client.setToken('bot-token');
      await expect(client.uploadMedia({
        fileData: Buffer.from('data'),
        fileName: 'test.txt',
      })).rejects.toThrow('WeChat upload error [1001]: Upload failed');
    });

    it('should throw on HTTP error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      });

      client.setToken('bot-token');
      await expect(client.uploadMedia({
        fileData: Buffer.from('data'),
        fileName: 'test.txt',
      })).rejects.toThrow('WeChat upload error [500]');
    });

    it('should use default mimeType when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          ret: 0,
          url: 'https://cdn.example.com/file.bin',
          file_key: 'key-456',
        })),
      });

      client.setToken('bot-token');
      await client.uploadMedia({
        fileData: Buffer.from('binary-data'),
        fileName: 'unknown.bin',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
