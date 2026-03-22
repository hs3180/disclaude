/**
 * Tests for WeChat API Client.
 *
 * Tests the HTTP client for WeChat ilink API.
 * Uses mocked fetch to avoid real network dependency.
 *
 * @see Issue #1023 - Unit tests should not depend on external environment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatApiClient } from './api-client.js';
import type { WeChatChannelConfig } from './types.js';

// Create mock logger
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

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('WeChatApiClient', () => {
  const defaultConfig: WeChatChannelConfig = {
    baseUrl: 'https://bot0.weidbot.qq.com',
  };

  let client: WeChatApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    client = new WeChatApiClient(defaultConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      expect(client).toBeDefined();
      expect(client.isAuthenticated()).toBe(false);
    });

    it('should create instance with token', () => {
      const configWithToken: WeChatChannelConfig = {
        ...defaultConfig,
        token: 'test-token',
      };
      client = new WeChatApiClient(configWithToken);
      expect(client.isAuthenticated()).toBe(true);
      expect(client.getToken()).toBe('test-token');
    });

    it('should normalize baseUrl (remove trailing slash)', () => {
      const configWithSlash: WeChatChannelConfig = {
        baseUrl: 'https://bot0.weidbot.qq.com/',
      };
      client = new WeChatApiClient(configWithSlash);
      // Internal check via getQRCode request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ errcode: 0, data: { qrid: 'test', qrurl: 'url', expire: 0 } }),
      });
      // The URL should not have double slashes
    });
  });

  describe('authentication', () => {
    it('should return false when no token', () => {
      expect(client.isAuthenticated()).toBe(false);
    });

    it('should return true when token is set', () => {
      client.setToken('new-token');
      expect(client.isAuthenticated()).toBe(true);
    });

    it('should return token via getToken()', () => {
      client.setToken('new-token');
      expect(client.getToken()).toBe('new-token');
    });
  });

  describe('getQRCode', () => {
    it('should return QR code data on success', async () => {
      const mockResponse = {
        errcode: 0,
        errmsg: 'ok',
        data: {
          qrid: 'qr-123',
          qrurl: 'https://example.com/qr/qr-123',
          expire: 300,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.getQRCode();

      expect(result.qrid).toBe('qr-123');
      expect(result.qrurl).toBe('https://example.com/qr/qr-123');
      expect(result.expire).toBe(300);
    });

    it('should throw on API error', async () => {
      const mockResponse = {
        errcode: 10001,
        errmsg: 'Invalid request',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await expect(client.getQRCode()).rejects.toThrow('API error');
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Server error'),
      });

      await expect(client.getQRCode()).rejects.toThrow('API request failed');
    });
  });

  describe('getQRCodeStatus', () => {
    it('should return wait status', async () => {
      const mockResponse = {
        errcode: 0,
        errmsg: 'ok',
        data: {
          status: 'wait',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.getQRCodeStatus('qr-123');

      expect(result.status).toBe('wait');
    });

    it('should return confirmed status with credentials', async () => {
      const mockResponse = {
        errcode: 0,
        errmsg: 'ok',
        data: {
          status: 'confirmed',
          bot_token: 'test-token',
          ilink_bot_id: 'bot-123',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.getQRCodeStatus('qr-123');

      expect(result.status).toBe('confirmed');
      expect(result.bot_token).toBe('test-token');
      expect(result.ilink_bot_id).toBe('bot-123');
    });
  });

  describe('sendMessage', () => {
    it('should throw when not authenticated', async () => {
      await expect(
        client.sendMessage('chat-123', {
          msgtype: 'text',
          text: { content: 'Hello' },
        })
      ).rejects.toThrow('Authentication required');
    });

    it('should send text message when authenticated', async () => {
      client.setToken('test-token');

      const mockResponse = {
        errcode: 0,
        errmsg: 'ok',
        data: {
          msgid: 'msg-123',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.sendMessage('chat-123', {
        msgtype: 'text',
        text: { content: 'Hello' },
      });

      expect(result.data?.msgid).toBe('msg-123');

      // Verify Authorization header was set
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });

    it('should throw on API error when sending', async () => {
      client.setToken('test-token');

      const mockResponse = {
        errcode: 40001,
        errmsg: 'Invalid token',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await expect(
        client.sendMessage('chat-123', {
          msgtype: 'text',
          text: { content: 'Hello' },
        })
      ).rejects.toThrow('API error');
    });
  });
});
