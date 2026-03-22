/**
 * Tests for WeChat Channel implementation.
 *
 * Tests the WeChat channel, API client, authentication,
 * message monitor, and media handler.
 *
 * @see Issue #1406 - WeChat Channel support
 * @see Issue #1023 - Unit tests should not depend on external environment
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { WeChatMonitor } from './monitor.js';
import { WeChatMediaHandler } from './media-handler.js';

// ─── Mock Logger ───

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
    DEFAULT_CHANNEL_CAPABILITIES: {
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
      supportedMcpTools: [],
    },
  };
});

// ─── Mock Fetch ───

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

// ─── Helper: create mock successful API response ───

function mockApiSuccess(data: unknown = {}) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
    status: 200,
    statusText: 'OK',
  };
}

function mockApiError(status: number, errorMsg: string) {
  return {
    ok: false,
    json: () => Promise.resolve({ success: false, errorMsg, errorCode: status }),
    status,
    statusText: 'Error',
  };
}

// ═══════════════════════════════════════════════════════
// WeChatApiClient Tests
// ═══════════════════════════════════════════════════════

describe('WeChatApiClient', () => {
  let client: WeChatApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new WeChatApiClient({
      baseUrl: 'https://api.example.com',
      cdnBaseUrl: 'https://cdn.example.com',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create client with correct base URL (trailing slashes stripped)', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com/' });
      expect(c).toBeDefined();
    });

    it('should use cdnBaseUrl from options', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', cdnBaseUrl: 'https://cdn.example.com' });
      expect(c).toBeDefined();
    });

    it('should fall back to baseUrl if no cdnBaseUrl', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      expect(c).toBeDefined();
    });
  });

  describe('token management', () => {
    it('should start without token', () => {
      expect(client.hasToken()).toBe(false);
      expect(client.getToken()).toBeUndefined();
    });

    it('should set and get token', () => {
      client.setToken('test-token');
      expect(client.hasToken()).toBe(true);
      expect(client.getToken()).toBe('test-token');
    });

    it('should update token', () => {
      client.setToken('token-1');
      client.setToken('token-2');
      expect(client.getToken()).toBe('token-2');
    });
  });

  describe('getBotQrCode', () => {
    it('should request QR code and return URL', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc123' }));

      const qrUrl = await client.getBotQrCode();

      expect(qrUrl).toBe('https://qr.example.com/abc123');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('ilink/bot/get_bot_qrcode');
      expect(callArgs[1].method).toBe('POST');
    });

    it('should throw if no qrUrl in response', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await expect(client.getBotQrCode()).rejects.toThrow('no qrUrl in response');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValue(mockApiError(500, 'Server Error'));

      await expect(client.getBotQrCode()).rejects.toThrow('Server Error');
    });
  });

  describe('getQrCodeStatus', () => {
    it('should return wait status', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({ status: 'wait' }));

      const result = await client.getQrCodeStatus();
      expect(result.status).toBe('wait');
    });

    it('should return scaned status', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({ status: 'scaned' }));

      const result = await client.getQrCodeStatus();
      expect(result.status).toBe('scaned');
    });

    it('should set token on confirmed status', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({
        status: 'confirmed',
        bot_token: 'my-bot-token',
        bot_id: 'bot-123',
      }));

      const result = await client.getQrCodeStatus();
      expect(result.status).toBe('confirmed');
      expect(result.botToken).toBe('my-bot-token');
      expect(result.botId).toBe('bot-123');
      expect(client.hasToken()).toBe(true);
      expect(client.getToken()).toBe('my-bot-token');
    });
  });

  describe('sendText', () => {
    beforeEach(() => {
      client.setToken('test-token');
    });

    it('should send text message with correct payload', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await client.sendText('chat-123', 'Hello World');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('ilink/bot/sendmessage');
      const body = JSON.parse(callArgs[1].body);
      expect(body.to).toBe('chat-123');
      expect(body.msgtype).toBe('text');
      expect(body.text.content).toBe('Hello World');
    });

    it('should include auth headers', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await client.sendText('chat-123', 'test');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-token');
      expect(headers['AuthorizationType']).toBe('ilink_bot_token');
    });
  });

  describe('sendImage', () => {
    beforeEach(() => {
      client.setToken('test-token');
    });

    it('should send image message with CDN URL', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await client.sendImage('chat-123', 'https://cdn.example.com/img.png', { width: 800, height: 600 });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.to).toBe('chat-123');
      expect(body.msgtype).toBe('image');
      expect(body.image.cdnUrl).toBe('https://cdn.example.com/img.png');
      expect(body.image.width).toBe(800);
      expect(body.image.height).toBe(600);
    });
  });

  describe('sendFile', () => {
    beforeEach(() => {
      client.setToken('test-token');
    });

    it('should send file message', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await client.sendFile('chat-123', 'report.pdf', 'https://cdn.example.com/file.pdf', 1024000);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.to).toBe('chat-123');
      expect(body.msgtype).toBe('file');
      expect(body.file.fileName).toBe('report.pdf');
      expect(body.file.cdnUrl).toBe('https://cdn.example.com/file.pdf');
      expect(body.file.fileSize).toBe(1024000);
    });
  });

  describe('getUpdates', () => {
    beforeEach(() => {
      client.setToken('test-token');
    });

    it('should return updates array', async () => {
      const updates = [{ msgId: '1', content: 'hello' }];
      mockFetch.mockResolvedValue(mockApiSuccess({ updates }));

      const result = await client.getUpdates(30);
      expect(result).toEqual(updates);
    });

    it('should return empty array if no updates', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({ updates: [] }));

      const result = await client.getUpdates(30);
      expect(result).toEqual([]);
    });
  });

  describe('getUploadUrl', () => {
    beforeEach(() => {
      client.setToken('test-token');
    });

    it('should return upload URL info', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({
        uploadUrl: 'https://upload.example.com/xyz',
        cdnUrl: 'https://cdn.example.com/xyz',
        expire_seconds: 3600,
      }));

      const result = await client.getUploadUrl('test.png', 1024);
      expect(result.uploadUrl).toBe('https://upload.example.com/xyz');
      expect(result.cdnUrl).toBe('https://cdn.example.com/xyz');
      expect(result.expireSeconds).toBe(3600);
    });

    it('should throw if no uploadUrl', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await expect(client.getUploadUrl('test.png', 1024)).rejects.toThrow('Failed to get upload URL');
    });
  });

  describe('uploadToCdn', () => {
    it('should upload file and return CDN URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ cdnUrl: 'https://cdn.example.com/abc' }),
        status: 200,
      });

      const result = await client.uploadToCdn('https://upload.example.com/xyz', Buffer.from('test'), 'image/png');
      expect(result).toBe('https://cdn.example.com/abc');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://upload.example.com/xyz');
      expect(callArgs[1].method).toBe('PUT');
      expect(callArgs[1].headers['Content-Type']).toBe('image/png');
    });

    it('should throw on upload failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
        status: 500,
        statusText: 'Server Error',
      });

      await expect(client.uploadToCdn('https://upload.example.com/xyz', Buffer.from('test'), 'image/png'))
        .rejects.toThrow('CDN upload failed');
    });
  });

  describe('sendTyping', () => {
    beforeEach(() => {
      client.setToken('test-token');
    });

    it('should send typing indicator', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({}));

      await client.sendTyping('chat-123');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('ilink/bot/sendtyping');
      const body = JSON.parse(callArgs[1].body);
      expect(body.to).toBe('chat-123');
    });
  });

  describe('error handling', () => {
    it('should handle network timeout', async () => {
      mockFetch.mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      client.setToken('test-token');
      await expect(client.sendText('chat-123', 'test')).rejects.toThrow('timeout');
    });
  });
});

// ═══════════════════════════════════════════════════════
// WeChatAuth Tests
// ═══════════════════════════════════════════════════════

describe('WeChatAuth', () => {
  let client: WeChatApiClient;
  let auth: WeChatAuth;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticate', () => {
    it('should complete full QR login flow', async () => {
      // Mock QR code generation
      mockFetch
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        // First poll: waiting
        .mockResolvedValueOnce(mockApiSuccess({ status: 'wait' }))
        // Second poll: scanned
        .mockResolvedValueOnce(mockApiSuccess({ status: 'scaned' }))
        // Third poll: confirmed
        .mockResolvedValueOnce(mockApiSuccess({
          status: 'confirmed',
          bot_token: 'my-token',
          bot_id: 'bot-123',
          user_info: { name: 'Test User', id: 'user-456' },
        }));

      auth = new WeChatAuth(client, { pollInterval: 10 });
      const result = await auth.authenticate();

      expect(result.success).toBe(true);
      expect(result.token).toBe('my-token');
      expect(result.botId).toBe('bot-123');
      expect(result.userInfo?.name).toBe('Test User');
    });

    it('should handle expired QR code', async () => {
      mockFetch
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        .mockResolvedValueOnce(mockApiSuccess({ status: 'expired' }));

      auth = new WeChatAuth(client, { pollInterval: 10, expiration: 1 });
      const result = await auth.authenticate();

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should be abortable', async () => {
      mockFetch
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        .mockResolvedValueOnce(mockApiSuccess({ status: 'wait' }));

      auth = new WeChatAuth(client, { pollInterval: 100 });

      // Start auth and abort after first poll
      const authPromise = auth.authenticate();
      await new Promise((resolve) => setTimeout(resolve, 50));
      auth.abort();

      const result = await authPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });
  });

  describe('isAuthenticating', () => {
    it('should return false before authenticate is called', () => {
      auth = new WeChatAuth(client);
      expect(auth.isAuthenticating()).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════
// WeChatMonitor Tests
// ═══════════════════════════════════════════════════════

describe('WeChatMonitor', () => {
  let client: WeChatApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
    client.setToken('test-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('should start and stop monitor', async () => {
      // getUpdates returns empty, then hangs
      mockFetch.mockResolvedValue(mockApiSuccess({ updates: [] }));

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });

      monitor.start();
      expect(monitor.isPolling()).toBe(true);
      expect(monitor.getState()).toBe('polling');

      // Give it a moment to start the first poll
      await new Promise((resolve) => setTimeout(resolve, 50));

      await monitor.stop();
      expect(monitor.isPolling()).toBe(false);
      expect(monitor.getState()).toBe('stopped');
    });

    it('should throw if started without token', () => {
      const noTokenClient = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      const monitor = new WeChatMonitor(noTokenClient);

      expect(() => monitor.start()).toThrow('without authentication token');
    });
  });

  describe('message handling', () => {
    it('should process and forward incoming messages', async () => {
      const receivedMessages: any[] = [];

      mockFetch.mockImplementation(() => {
        // Return updates on first call, then hang
        const updates = [{
          msgId: 'msg-001',
          chatId: 'chat-123',
          fromUser: { id: 'user-001', name: 'Test' },
          chatType: 'p2p',
          msgType: 'text',
          text: { content: 'Hello bot' },
          timestamp: Date.now(),
        }];
        return new Promise((resolve) => {
          resolve(mockApiSuccess({ updates }));
        });
      });

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });
      monitor.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await monitor.stop();

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].messageId).toBe('msg-001');
      expect(receivedMessages[0].chatId).toBe('chat-123');
      expect(receivedMessages[0].content).toBe('Hello bot');
      expect(receivedMessages[0].userId).toBe('user-001');
      expect(receivedMessages[0].messageType).toBe('text');
    });

    it('should deduplicate messages', async () => {
      const receivedMessages: any[] = [];

      // Return same message twice
      const updates = [{
        msgId: 'msg-dup',
        chatId: 'chat-123',
        fromUser: { id: 'user-001' },
        chatType: 'p2p',
        msgType: 'text',
        text: { content: 'Duplicate' },
        timestamp: Date.now(),
      }];

      mockFetch.mockResolvedValueOnce(mockApiSuccess({ updates }));
      mockFetch.mockResolvedValueOnce(mockApiSuccess({ updates }));

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });
      monitor.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await monitor.stop();

      // Should only receive once despite being returned twice
      expect(receivedMessages.length).toBe(1);
    });

    it('should handle image messages', async () => {
      const receivedMessages: any[] = [];

      const updates = [{
        msgId: 'msg-img',
        chatId: 'chat-123',
        fromUser: { id: 'user-001' },
        chatType: 'p2p',
        msgType: 'image',
        image: { cdnUrl: 'https://cdn.example.com/img.png', fileSize: 50000, width: 800, height: 600 },
        timestamp: Date.now(),
      }];

      mockFetch.mockResolvedValue(mockApiSuccess({ updates }));

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });
      monitor.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await monitor.stop();

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].messageType).toBe('image');
      expect(receivedMessages[0].attachments).toBeDefined();
      expect(receivedMessages[0].attachments![0].filePath).toBe('https://cdn.example.com/img.png');
    });

    it('should handle file messages', async () => {
      const receivedMessages: any[] = [];

      const updates = [{
        msgId: 'msg-file',
        chatId: 'chat-123',
        fromUser: { id: 'user-001' },
        chatType: 'p2p',
        msgType: 'file',
        file: { fileName: 'report.pdf', cdnUrl: 'https://cdn.example.com/report.pdf', fileSize: 1024000 },
        timestamp: Date.now(),
      }];

      mockFetch.mockResolvedValue(mockApiSuccess({ updates }));

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });
      monitor.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await monitor.stop();

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].messageType).toBe('file');
      expect(receivedMessages[0].attachments![0].fileName).toBe('report.pdf');
    });

    it('should handle group messages with mentions', async () => {
      const receivedMessages: any[] = [];

      const updates = [{
        msgId: 'msg-group',
        chatId: 'group-123',
        fromUser: { id: 'user-001', name: 'Test' },
        chatType: 'group',
        msgType: 'text',
        text: { content: '@bot hello' },
        timestamp: Date.now(),
        mentionedUserIds: ['bot-id-001'],
      }];

      mockFetch.mockResolvedValue(mockApiSuccess({ updates }));

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });
      monitor.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await monitor.stop();

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].metadata?.chatType).toBe('group');
      expect(receivedMessages[0].metadata?.mentionedUserIds).toEqual(['bot-id-001']);
    });
  });

  describe('error recovery', () => {
    it('should back off on API errors and retry', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve(mockApiSuccess({ updates: [] }));
      });

      const monitor = new WeChatMonitor(client, { pollTimeout: 1 });
      monitor.start();
      // Wait enough for retry
      await new Promise((resolve) => setTimeout(resolve, 200));
      await monitor.stop();

      // Should have retried after the error
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });
});

// ═══════════════════════════════════════════════════════
// WeChatMediaHandler Tests
// ═══════════════════════════════════════════════════════

describe('WeChatMediaHandler', () => {
  let client: WeChatApiClient;
  let handler: WeChatMediaHandler;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
    client.setToken('test-token');
    handler = new WeChatMediaHandler(client);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isImageFile', () => {
    it('should detect image extensions', () => {
      expect(handler.isImageFile('.png')).toBe(true);
      expect(handler.isImageFile('.jpg')).toBe(true);
      expect(handler.isImageFile('.jpeg')).toBe(true);
      expect(handler.isImageFile('.gif')).toBe(true);
      expect(handler.isImageFile('.webp')).toBe(true);
    });

    it('should reject non-image extensions', () => {
      expect(handler.isImageFile('.pdf')).toBe(false);
      expect(handler.isImageFile('.doc')).toBe(false);
      expect(handler.isImageFile('.txt')).toBe(false);
    });
  });

  describe('getMimeType', () => {
    it('should return correct MIME types', () => {
      expect(handler.getMimeType('.png')).toBe('image/png');
      expect(handler.getMimeType('.pdf')).toBe('application/pdf');
      expect(handler.getMimeType('.json')).toBe('application/json');
    });

    it('should return octet-stream for unknown types', () => {
      expect(handler.getMimeType('.xyz')).toBe('application/octet-stream');
    });
  });

  describe('uploadFile', () => {
    it('should throw if file does not exist', async () => {
      await expect(handler.uploadFile('/nonexistent/file.txt'))
        .rejects.toThrow('File not found');
    });
  });
});

// ═══════════════════════════════════════════════════════
// WeChatChannel Tests
// ═══════════════════════════════════════════════════════

describe('WeChatChannel', () => {
  let channel: WeChatChannel;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create channel with default config', () => {
      channel = new WeChatChannel();
      expect(channel).toBeDefined();
      expect(channel.id).toBe('wechat');
      expect(channel.name).toBe('WeChat');
    });

    it('should create channel with custom config', () => {
      channel = new WeChatChannel({
        id: 'wechat-prod',
        baseUrl: 'https://api.example.com',
        token: 'pre-configured-token',
      });
      expect(channel.id).toBe('wechat-prod');
    });

    it('should read baseUrl from environment', () => {
      process.env.WECHAT_API_BASE_URL = 'https://env.example.com';
      channel = new WeChatChannel();
      expect(channel).toBeDefined();
      delete process.env.WECHAT_API_BASE_URL;
    });
  });

  describe('doStart', () => {
    it('should throw if no baseUrl configured', async () => {
      channel = new WeChatChannel({});
      await expect(channel.start()).rejects.toThrow('requires baseUrl');
    });

    it('should authenticate and start monitor', async () => {
      mockFetch
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        .mockResolvedValueOnce(mockApiSuccess({
          status: 'confirmed',
          bot_token: 'bot-token-123',
          bot_id: 'bot-456',
        }))
        .mockResolvedValue(mockApiSuccess({ updates: [] })); // getUpdates

      channel = new WeChatChannel({ baseUrl: 'https://api.example.com' });

      await channel.start();

      expect(channel.status).toBe('running');
      expect(channel.isHealthy()).toBe(true);

      await channel.stop();
    });

    it('should skip auth when token is pre-configured', async () => {
      mockFetch.mockResolvedValue(mockApiSuccess({ updates: [] }));

      channel = new WeChatChannel({
        baseUrl: 'https://api.example.com',
        token: 'pre-token',
      });

      await channel.start();

      expect(channel.status).toBe('running');
      // Verify no QR code generation call was made
      const qrCalls = mockFetch.mock.calls.filter(
        (call: any[]) => call[0].includes('get_bot_qrcode')
      );
      expect(qrCalls.length).toBe(0);

      await channel.stop();
    });

    it('should throw on authentication failure', async () => {
      mockFetch
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        .mockResolvedValueOnce(mockApiSuccess({ status: 'expired' }));

      channel = new WeChatChannel({
        baseUrl: 'https://api.example.com',
        qrExpiration: 1,
      });

      await expect(channel.start()).rejects.toThrow('Authentication failed');
    });
  });

  describe('doSendMessage', () => {
    beforeEach(async () => {
      // Start channel with pre-configured token
      mockFetch.mockResolvedValue(mockApiSuccess({ updates: [] }));
      channel = new WeChatChannel({
        baseUrl: 'https://api.example.com',
        token: 'test-token',
      });
      await channel.start();
    });

    afterEach(async () => {
      await channel.stop();
    });

    it('should send text messages', async () => {
      mockFetch.mockResolvedValueOnce(mockApiSuccess({}));

      await channel.sendMessage({ chatId: 'chat-123', type: 'text', text: 'Hello' });

      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(callArgs[0]).toContain('ilink/bot/sendmessage');
      const body = JSON.parse(callArgs[1].body);
      expect(body.msgtype).toBe('text');
      expect(body.text.content).toBe('Hello');
    });

    it('should convert card messages to text', async () => {
      mockFetch.mockResolvedValueOnce(mockApiSuccess({}));

      await channel.sendMessage({
        chatId: 'chat-123',
        type: 'card',
        card: {
          elements: [
            { tag: 'markdown', content: '## Title\nSome content' },
          ],
        },
      });

      const callArgs = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const body = JSON.parse(callArgs[1].body);
      expect(body.msgtype).toBe('text');
      expect(body.text.content).toBe('## Title\nSome content');
    });

    it('should handle done signal (no-op)', async () => {
      // Should not throw
      await channel.sendMessage({ chatId: 'chat-123', type: 'done' });
    });

    it('should throw for file messages without filePath', async () => {
      await expect(channel.sendMessage({ chatId: 'chat-123', type: 'file' }))
        .rejects.toThrow('File path is required');
    });

    it('should throw for unsupported message types', async () => {
      await expect(
        channel.sendMessage({ chatId: 'chat-123', type: 'unknown' as any })
      ).rejects.toThrow('Unsupported message type');
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      channel = new WeChatChannel({ baseUrl: 'https://api.example.com' });
      const caps = channel.getCapabilities();

      expect(caps.supportsCard).toBe(false);
      expect(caps.supportsThread).toBe(false);
      expect(caps.supportsFile).toBe(true);
      expect(caps.supportsMarkdown).toBe(false);
      expect(caps.supportsMention).toBe(true);
      expect(caps.supportsUpdate).toBe(false);
      expect(caps.supportedMcpTools).toContain('mcp__channel-mcp__send_text');
      expect(caps.supportedMcpTools).toContain('mcp__channel-mcp__send_file');
    });
  });

  describe('checkHealth', () => {
    it('should return false when not running', () => {
      channel = new WeChatChannel({ baseUrl: 'https://api.example.com' });
      // Not started yet - status is 'stopped'
      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('should handle start → stop → start cycle', async () => {
      mockFetch
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        .mockResolvedValueOnce(mockApiSuccess({
          status: 'confirmed',
          bot_token: 'token-1',
          bot_id: 'bot-1',
        }))
        .mockResolvedValueOnce(mockApiSuccess({ updates: [] }))
        // Second start cycle
        .mockResolvedValueOnce(mockApiSuccess({ qrUrl: 'https://qr.example.com/abc' }))
        .mockResolvedValueOnce(mockApiSuccess({
          status: 'confirmed',
          bot_token: 'token-2',
          bot_id: 'bot-2',
        }))
        .mockResolvedValueOnce(mockApiSuccess({ updates: [] }));

      channel = new WeChatChannel({ baseUrl: 'https://api.example.com' });

      await channel.start();
      expect(channel.status).toBe('running');

      await channel.stop();
      expect(channel.status).toBe('stopped');

      await channel.start();
      expect(channel.status).toBe('running');

      await channel.stop();
      expect(channel.status).toBe('stopped');
    });
  });
});
