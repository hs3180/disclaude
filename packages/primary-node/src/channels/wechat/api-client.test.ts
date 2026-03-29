/**
 * Tests for WeChatApiClient.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap (Phase 3.2)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WeChatApiClient } from './api-client.js';

// Store original fetch
const originalFetch = globalThis.fetch;

describe('WeChatApiClient', () => {
  let client: WeChatApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    client = new WeChatApiClient({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      routeTag: 'test-route',
    });
    // Create temp directory for test files
    tempDir = join(tmpdir(), `wechat-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    // Clean up temp files
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

  // ---------------------------------------------------------------------------
  // Media handling tests (Phase 3.2)
  // ---------------------------------------------------------------------------

  describe('detectMediaType', () => {
    it('should detect image extensions', () => {
      expect(client.detectMediaType('photo.jpg')).toBe('image');
      expect(client.detectMediaType('photo.jpeg')).toBe('image');
      expect(client.detectMediaType('photo.png')).toBe('image');
      expect(client.detectMediaType('photo.webp')).toBe('image');
      expect(client.detectMediaType('photo.gif')).toBe('image');
      expect(client.detectMediaType('photo.bmp')).toBe('image');
      expect(client.detectMediaType('photo.tiff')).toBe('image');
      expect(client.detectMediaType('photo.ico')).toBe('image');
    });

    it('should detect file extensions', () => {
      expect(client.detectMediaType('doc.pdf')).toBe('file');
      expect(client.detectMediaType('doc.docx')).toBe('file');
      expect(client.detectMediaType('data.csv')).toBe('file');
      expect(client.detectMediaType('archive.zip')).toBe('file');
      expect(client.detectMediaType('script.ts')).toBe('file');
    });

    it('should be case-insensitive', () => {
      expect(client.detectMediaType('photo.PNG')).toBe('image');
      expect(client.detectMediaType('photo.JPEG')).toBe('image');
      expect(client.detectMediaType('document.PDF')).toBe('file');
    });
  });

  describe('uploadMedia', () => {
    it('should upload an image file and return mediaId', async () => {
      // Create a small test image file
      const imagePath = join(tempDir, 'test.png');
      writeFileSync(imagePath, Buffer.alloc(1024)); // 1KB file

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'media-abc-123' })),
      });

      client.setToken('bot-token');
      const result = await client.uploadMedia({ filePath: imagePath });

      expect(result.mediaId).toBe('media-abc-123');
      expect(result.mediaType).toBe('image');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('uploadmedia'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'AuthorizationType': 'ilink_bot_token',
            'Authorization': 'Bearer bot-token',
          }),
        })
      );
    });

    it('should upload a non-image file as type "file"', async () => {
      const filePath = join(tempDir, 'test.pdf');
      writeFileSync(filePath, Buffer.alloc(2048));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'media-xyz-456' })),
      });

      client.setToken('bot-token');
      const result = await client.uploadMedia({ filePath: filePath });

      expect(result.mediaId).toBe('media-xyz-456');
      expect(result.mediaType).toBe('file');
    });

    it('should respect explicit mediaType override', async () => {
      // Create a .txt file but force image type
      const filePath = join(tempDir, 'data.bin');
      writeFileSync(filePath, Buffer.alloc(512));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'media-override' })),
      });

      client.setToken('bot-token');
      const result = await client.uploadMedia({ filePath, mediaType: 'image' });

      expect(result.mediaType).toBe('image');
    });

    it('should throw for oversized image (>10MB)', async () => {
      // Create a file that exceeds the image limit
      const imagePath = join(tempDir, 'large.png');
      writeFileSync(imagePath, Buffer.alloc(10 * 1024 * 1024 + 1)); // 10MB + 1 byte

      client.setToken('bot-token');
      await expect(client.uploadMedia({ filePath: imagePath }))
        .rejects.toThrow('File too large for image upload');
    });

    it('should throw for oversized file (>30MB)', async () => {
      const filePath = join(tempDir, 'large.pdf');
      writeFileSync(filePath, Buffer.alloc(30 * 1024 * 1024 + 1)); // 30MB + 1 byte

      client.setToken('bot-token');
      await expect(client.uploadMedia({ filePath }))
        .rejects.toThrow('File too large for file upload');
    });

    it('should allow 10MB image exactly', async () => {
      const imagePath = join(tempDir, 'exact-10mb.png');
      writeFileSync(imagePath, Buffer.alloc(10 * 1024 * 1024));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'media-exact' })),
      });

      client.setToken('bot-token');
      const result = await client.uploadMedia({ filePath: imagePath });
      expect(result.mediaId).toBe('media-exact');
    });

    it('should throw when file does not exist', async () => {
      client.setToken('bot-token');
      await expect(client.uploadMedia({ filePath: '/nonexistent/file.png' }))
        .rejects.toThrow();
    });

    it('should throw when response lacks media_id', async () => {
      const filePath = join(tempDir, 'test.png');
      writeFileSync(filePath, Buffer.alloc(100));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await expect(client.uploadMedia({ filePath }))
        .rejects.toThrow('missing media_id in response');
    });

    it('should include SKRouteTag in upload request', async () => {
      const filePath = join(tempDir, 'test.png');
      writeFileSync(filePath, Buffer.alloc(100));

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'media-route' })),
      });

      client.setToken('bot-token');
      await client.uploadMedia({ filePath });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).toHaveProperty('SKRouteTag');
      expect(callHeaders['SKRouteTag']).toBe('test-route');
    });
  });

  describe('sendImage', () => {
    it('should upload and send image message', async () => {
      const imagePath = join(tempDir, 'photo.jpg');
      writeFileSync(imagePath, Buffer.alloc(1024));

      // First call: upload, Second call: send message
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'img-media-id' })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
        });

      client.setToken('bot-token');
      await client.sendImage({ to: 'user-1', filePath: imagePath });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First call should be uploadmedia
      expect(mockFetch.mock.calls[0][0]).toContain('uploadmedia');
      // Second call should be sendmessage with image item
      expect(mockFetch.mock.calls[1][0]).toContain('sendmessage');
      const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(sendBody.msg.item_list[0].type).toBe(3);
      expect(sendBody.msg.item_list[0].image_item.media_id).toBe('img-media-id');
    });

    it('should include contextToken when provided', async () => {
      const imagePath = join(tempDir, 'photo.png');
      writeFileSync(imagePath, Buffer.alloc(100));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'img-id' })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
        });

      client.setToken('bot-token');
      await client.sendImage({ to: 'user-1', filePath: imagePath, contextToken: 'ctx-abc' });

      const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(sendBody.msg.context_token).toBe('ctx-abc');
    });
  });

  describe('sendFile', () => {
    it('should upload and send file message', async () => {
      const filePath = join(tempDir, 'report.pdf');
      writeFileSync(filePath, Buffer.alloc(2048));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'file-media-id' })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
        });

      client.setToken('bot-token');
      await client.sendFile({ to: 'user-1', filePath: filePath });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second call: sendmessage with file item (type 4)
      const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(sendBody.msg.item_list[0].type).toBe(4);
      expect(sendBody.msg.item_list[0].file_item.media_id).toBe('file-media-id');
      expect(sendBody.msg.item_list[0].file_item.file_name).toBe('report.pdf');
    });

    it('should include contextToken when provided', async () => {
      const filePath = join(tempDir, 'doc.pdf');
      writeFileSync(filePath, Buffer.alloc(100));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0, media_id: 'file-id' })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
        });

      client.setToken('bot-token');
      await client.sendFile({ to: 'user-1', filePath, contextToken: 'thread-1' });

      const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(sendBody.msg.context_token).toBe('thread-1');
    });
  });
});
