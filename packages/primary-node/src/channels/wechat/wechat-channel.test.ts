/**
 * Tests for WeChatChannel (MVP).
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';
// Mock the API client
const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockSendImage = vi.fn().mockResolvedValue(undefined);
const mockSendFile = vi.fn().mockResolvedValue(undefined);
const mockUploadMedia = vi.fn().mockResolvedValue({ url: 'https://cdn.example.com/file.png', fileKey: 'key-123' });
const mockSetToken = vi.fn();
const mockHasToken = vi.fn().mockReturnValue(true);

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn().mockImplementation(() => ({
    sendText: mockSendText,
    sendImage: mockSendImage,
    sendFile: mockSendFile,
    uploadMedia: mockUploadMedia,
    setToken: mockSetToken,
    hasToken: mockHasToken,
  })),
}));

// Mock the auth module
vi.mock('./auth.js', () => ({
  WeChatAuth: vi.fn().mockImplementation(() => ({
    authenticate: vi.fn().mockResolvedValue({
      success: true,
      token: 'mock-bot-token',
      botId: 'mock-bot-id',
      userId: 'mock-user-id',
    }),
    isAuthenticating: vi.fn().mockReturnValue(false),
    abort: vi.fn(),
  })),
}));

// Mock node:fs/promises — use importOriginal to preserve other exports
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue(Buffer.from('fake-file-content')),
  };
});

describe('WeChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasToken.mockReturnValue(true);
    mockSendText.mockResolvedValue(undefined);
    mockSendImage.mockResolvedValue(undefined);
    mockSendFile.mockResolvedValue(undefined);
    mockUploadMedia.mockResolvedValue({ url: 'https://cdn.example.com/file.png', fileKey: 'key-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create channel with default base URL', () => {
      const channel = new WeChatChannel();
      expect(channel.id).toBeDefined();
      expect(channel.name).toBe('WeChat');
    });

    it('should create channel with custom config', () => {
      const channel = new WeChatChannel({
        baseUrl: 'https://custom.api.com',
        token: 'test-token',
        routeTag: 'test-route',
      });
      expect(channel.id).toBeDefined();
      expect(channel.name).toBe('WeChat');
    });

    it('should create channel with empty config', () => {
      const channel = new WeChatChannel({});
      expect(channel.id).toBeDefined();
    });
  });

  describe('getCapabilities', () => {
    it('should return capabilities with file support', () => {
      const channel = new WeChatChannel();
      const caps = channel.getCapabilities();
      expect(caps).toEqual({
        supportsCard: false,
        supportsThread: false,
        supportsFile: true,
        supportsMarkdown: false,
        supportsMention: false,
        supportsUpdate: false,
        supportedMcpTools: ['send_text', 'send_file'],
      });
    });
  });

  describe('doSendMessage', () => {
    it('should throw if client is not initialized', async () => {
      const channel = new WeChatChannel();
      // Access protected method via any cast for testing
      await expect(
        (channel as any).doSendMessage({ chatId: 'test', type: 'text', text: 'hello' })
      ).rejects.toThrow('WeChat client not initialized');
    });

    it('should send text messages via API client', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start(); // initializes client
      // Manually set the client since mock doesn't fully work
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello WeChat!',
      });

      expect(mockSendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: 'Hello WeChat!',
        contextToken: undefined,
      });
    });

    it('should send text with threadId as contextToken', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello in thread',
        threadId: 'thread-123',
      });

      expect(mockSendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: 'Hello in thread',
        contextToken: 'thread-123',
      });
    });

    it('should downgrade card messages to JSON text', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      const card = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'test' } }] };
      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'card',
        card,
      });

      expect(mockSendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: JSON.stringify(card),
        contextToken: undefined,
      });
    });

    it('should downgrade card with threadId', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      const card = { elements: [] };
      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'card',
        card,
        threadId: 'thread-456',
      });

      expect(mockSendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: JSON.stringify(card),
        contextToken: 'thread-456',
      });
    });

    it('should not send empty text messages', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      // Empty text should fall through to warn
      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: '',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should handle file messages via CDN upload', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/tmp/document.pdf',
      });

      // uploadMedia should be called (fileData comes from readFile mock)
      expect(mockUploadMedia).toHaveBeenCalledTimes(1);
      expect(mockUploadMedia.mock.calls[0][0].fileName).toBe('document.pdf');
      expect(mockUploadMedia.mock.calls[0][0].mimeType).toBe('application/pdf');
      expect(mockSendFile).toHaveBeenCalledWith({
        to: 'chat-1',
        fileUrl: 'https://cdn.example.com/file.png',
        fileName: 'document.pdf',
        contextToken: undefined,
      });
      expect(mockSendImage).not.toHaveBeenCalled();
    });

    it('should send image files as image messages', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/tmp/photo.png',
      });

      expect(mockUploadMedia).toHaveBeenCalledTimes(1);
      expect(mockUploadMedia.mock.calls[0][0].fileName).toBe('photo.png');
      expect(mockUploadMedia.mock.calls[0][0].mimeType).toBe('image/png');
      expect(mockSendImage).toHaveBeenCalledWith({
        to: 'chat-1',
        imageUrl: 'https://cdn.example.com/file.png',
        contextToken: undefined,
      });
      expect(mockSendFile).not.toHaveBeenCalled();
    });

    it('should ignore file messages without filePath', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
      });

      expect(mockUploadMedia).not.toHaveBeenCalled();
    });

    it('should ignore done signal type', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'done',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });
  });

  describe('checkHealth', () => {
    it('should return true when client has token', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mockHasToken };
      mockHasToken.mockReturnValue(true);
      expect((channel as any).checkHealth()).toBe(true);
    });

    it('should return false when client has no token', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mockHasToken };
      mockHasToken.mockReturnValue(false);
      expect((channel as any).checkHealth()).toBe(false);
    });

    it('should return false when client is not initialized', () => {
      const channel = new WeChatChannel();
      expect((channel as any).checkHealth()).toBe(false);
    });
  });

  describe('getApiClient', () => {
    it('should return undefined when not started', () => {
      const channel = new WeChatChannel();
      expect(channel.getApiClient()).toBeUndefined();
    });
  });
});
