/**
 * Tests for WeChatChannel.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.3)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';

// Create mock functions with hoisted so they're available in vi.mock
const mockSendText = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendImage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUploadMedia = vi.hoisted(() => vi.fn().mockResolvedValue({ url: 'https://cdn.example.com/test.png', fileKey: 'key-123' }));
const mockSetToken = vi.hoisted(() => vi.fn());
const mockHasToken = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockStatSync = vi.hoisted(() => vi.fn().mockReturnValue({ size: 1024 }));
const mockReadFileSync = vi.hoisted(() => vi.fn().mockReturnValue(Buffer.from('fake-file-data')));

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

// Mock fs module — keep real exports, override statSync and readFileSync
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: mockStatSync,
    readFileSync: mockReadFileSync,
  };
});

describe('WeChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasToken.mockReturnValue(true);
    mockSendText.mockResolvedValue(undefined);
    mockSendImage.mockResolvedValue(undefined);
    mockSendFile.mockResolvedValue(undefined);
    mockUploadMedia.mockResolvedValue({ url: 'https://cdn.example.com/test.png', fileKey: 'key-123' });
    mockStatSync.mockReturnValue({ size: 1024 });
    mockReadFileSync.mockReturnValue(Buffer.from('fake-file-data'));
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
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

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
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

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
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

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
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

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
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      // Empty text should fall through to warn
      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: '',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should ignore done signal type', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'done',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });
  });

  describe('doSendMessage - file handling (Phase 3.3)', () => {
    it('should throw when file message has no filePath', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await expect((channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
      })).rejects.toThrow('File path is required');
    });

    it('should upload and send image files via sendImage', async () => {
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

      expect(mockUploadMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: 'photo.png',
          mimeType: 'image/png',
        })
      );
      expect(mockSendImage).toHaveBeenCalledWith({
        to: 'chat-1',
        imageUrl: 'https://cdn.example.com/test.png',
        contextToken: undefined,
      });
      expect(mockSendFile).not.toHaveBeenCalled();
    });

    it('should upload and send non-image files via sendFile', async () => {
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

      expect(mockUploadMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: 'document.pdf',
          mimeType: 'application/pdf',
        })
      );
      expect(mockSendFile).toHaveBeenCalledWith({
        to: 'chat-1',
        fileUrl: 'https://cdn.example.com/test.png',
        fileName: 'document.pdf',
        contextToken: undefined,
      });
      expect(mockSendImage).not.toHaveBeenCalled();
    });

    it('should pass threadId to image/file send methods', async () => {
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
        filePath: '/tmp/photo.jpg',
        threadId: 'thread-abc',
      });

      expect(mockSendImage).toHaveBeenCalledWith(
        expect.objectContaining({
          contextToken: 'thread-abc',
        })
      );
    });

    it('should throw when file does not exist', async () => {
      mockStatSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });

      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await expect((channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/tmp/nonexistent.png',
      })).rejects.toThrow('File not found');
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
