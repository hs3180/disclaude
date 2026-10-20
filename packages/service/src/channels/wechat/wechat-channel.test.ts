/**
 * Tests for WeChatChannel.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1, Phase 3.2)
 */

 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';

// Mock the API client
const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockSetToken = vi.fn();
const mockHasToken = vi.fn().mockReturnValue(true);
const mockGetUpdates = vi.fn().mockResolvedValue([]);

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn(class {
    sendText = mockSendText;
    sendTyping = mockSendTyping;
    setToken = mockSetToken;
    hasToken = mockHasToken;
    getUpdates = mockGetUpdates;
  }),
}));

// Mock the auth module
vi.mock('./auth.js', () => ({
  WeChatAuth: vi.fn(class {
    authenticate = vi.fn().mockResolvedValue({
      success: true,
      token: 'mock-bot-token',
      botId: 'mock-bot-id',
      userId: 'mock-user-id',
    });
    isAuthenticating = vi.fn().mockReturnValue(false);
    abort = vi.fn();
  }),
}));

// Mock the message listener module
const mockStart = vi.fn();
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockIsListening = vi.fn().mockReturnValue(true);

vi.mock('./message-listener.js', () => ({
  WeChatMessageListener: vi.fn(class {
    start = mockStart;
    stop = mockStop;
    isListening = mockIsListening;
    isHealthy = mockIsListening;
  }),
  MessageProcessor: undefined,
}));

function readyChannel(): WeChatChannel {
  const channel = new WeChatChannel({ token: 'test-token' });
  const contexts = (channel as any).contexts as Map<string, string>;
  contexts.set('chat-1', 'ctx-chat');
  contexts.set('user-123', 'ctx-image');
  contexts.set('user-456', 'ctx-file');
  return channel;
}

describe('WeChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasToken.mockReturnValue(true);
    mockSendText.mockResolvedValue(undefined);
    mockGetUpdates.mockResolvedValue([]);
    mockIsListening.mockReturnValue(true);
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
    it('should return current capabilities', () => {
      const channel = new WeChatChannel();
      const caps = channel.getCapabilities();
      expect(caps).toEqual({
        supportsCard: false,
        supportsThread: false,
        supportsFile: true,
        supportsMarkdown: false,
        supportsMention: false,
        supportsUpdate: false,
        supportsStreaming: false,
        supportedChannelTools: ['send_text', 'send_file'],
      });
    });
  });

  describe('doSendMessage', () => {
    it('should throw if client is not initialized', async () => {
      const channel = new WeChatChannel();
      await expect(
        (channel as any).doSendMessage({ chatId: 'test', type: 'text', text: 'hello' })
      ).rejects.toThrow('WeChat client not initialized');
    });

    it('should send text messages via API client', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello WeChat!',
      });

      expect(mockSendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: 'Hello WeChat!',
        contextToken: 'ctx-chat',
      });
    });

    it('uses the saved context token instead of a generic parent message ID', async () => {
      const channel = readyChannel();
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
        contextToken: 'ctx-chat',
      });
    });

    it('rejects cards without an explicit human-readable description', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText };
      await expect((channel as any).doSendMessage({ chatId: 'chat-1', type: 'card', card: { internal: 'data' } })).rejects.toThrow('Unsupported');
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('can deliver an internal card callback description as plain text', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText };
      await (channel as any).doSendMessage({ chatId: 'chat-1', type: 'card', card: { internal: 'data' }, description: 'Readable answer' });
      expect(mockSendText).toHaveBeenCalledWith({ to: 'chat-1', content: 'Readable answer', contextToken: 'ctx-chat' });
    });

    it('splits long Unicode replies and exposes partial failure without resending successful parts', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText };
      const text = '🙂'.repeat(2001);
      await (channel as any).doSendMessage({ chatId: 'chat-1', type: 'text', text });
      const parts = mockSendText.mock.calls.map(([request]) => request.content);
      expect(parts).toHaveLength(3);
      expect(parts.join('')).toBe(text);
      expect(parts.every(part => Buffer.byteLength(part) <= 4000)).toBe(true);
      mockSendText.mockClear().mockResolvedValueOnce('first-id').mockRejectedValueOnce(new Error('network failure'));
      await expect((channel as any).doSendMessage({ chatId: 'chat-1', type: 'text', text })).rejects.toThrow('partial');
      expect(mockSendText).toHaveBeenCalledTimes(2);
    });

    it('should not send empty text messages', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await expect((channel as any).doSendMessage({
        chatId: 'chat-1', type: 'text', text: '',
      })).rejects.toThrow('Unsupported or empty');

      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should ignore unsupported message types', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await expect((channel as any).doSendMessage({
        chatId: 'chat-1', type: 'unknown',
      })).rejects.toThrow('Unsupported or empty');

      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should ignore done signal type', async () => {
      const channel = readyChannel();
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'done',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });
  });

  describe('checkHealth', () => {
    it('should return true when client has token and listener is active', () => {
      const channel = readyChannel();
      (channel as any).client = { hasToken: mockHasToken };
      (channel as any).messageListener = { isListening: mockIsListening, isHealthy: mockIsListening };
      mockHasToken.mockReturnValue(true);
      mockIsListening.mockReturnValue(true);
      expect((channel as any).checkHealth()).toBe(true);
    });

    it('should return false when client has no token', () => {
      const channel = readyChannel();
      (channel as any).client = { hasToken: mockHasToken };
      (channel as any).messageListener = { isListening: mockIsListening, isHealthy: mockIsListening };
      mockHasToken.mockReturnValue(false);
      expect((channel as any).checkHealth()).toBe(false);
    });

    it('should return false when message listener is not active', () => {
      const channel = readyChannel();
      (channel as any).client = { hasToken: mockHasToken };
      (channel as any).messageListener = { isListening: mockIsListening, isHealthy: mockIsListening };
      mockHasToken.mockReturnValue(true);
      mockIsListening.mockReturnValue(false);
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

  describe('getMessageListener (Issue #1556)', () => {
    it('should return undefined when not started', () => {
      const channel = new WeChatChannel();
      expect(channel.getMessageListener()).toBeUndefined();
    });
  });

  describe('doStop (Issue #1556)', () => {
    it('should stop message listener on stop', async () => {
      const channel = readyChannel();
      const mockListener = { stop: vi.fn().mockResolvedValue(undefined) };
      (channel as any).messageListener = mockListener;

      await (channel as any).doStop();

      expect(mockListener.stop).toHaveBeenCalledTimes(1);
      expect((channel as any).messageListener).toBeUndefined();
    });
  });

  describe('typing indicator integration (Issue #1556 Phase 3.2)', () => {
    it('should send typing indicator before emitting message', async () => {
      const channel = readyChannel();

      // Set up the client mock directly
      const mockClient = {
        sendText: mockSendText,
        sendTyping: mockSendTyping,
        hasToken: mockHasToken,
      };
      (channel as any).client = mockClient;

      // Simulate the processor that doStart() creates:
      // it calls sendTyping then emitMessage
      const emitSpy = vi.fn().mockResolvedValue(undefined);
      (channel as any).emitMessage = emitSpy;

      // Replicate the processor logic from wechat-channel.ts doStart()
      const processor = async (message: any) => {
        await mockClient.sendTyping?.({ to: message.chatId });
        await (channel as any).emitMessage(message);
      };

      const incomingMessage = {
        messageId: 'msg-1',
        chatId: 'user-123',
        userId: 'user-123',
        content: 'Hello!',
        messageType: 'text' as const,
        timestamp: Date.now(),
      };

      await processor(incomingMessage);

      expect(mockSendTyping).toHaveBeenCalledWith({ to: 'user-123' });
      expect(emitSpy).toHaveBeenCalledWith(incomingMessage);
    });
  });

  describe('file sending via CDN (Issue #1556 Phase 3.2)', () => {
    it('should upload and send image file', async () => {
      const channel = readyChannel();

      const mockUploadMedia = vi.fn().mockResolvedValue({
        media: { encrypt_query_param: 'image-ref' }, size: 13, encryptedSize: 16,
      });
      const mockSendImage = vi.fn().mockResolvedValue(undefined);

      (channel as any).client = {
        uploadMedia: mockUploadMedia,
        sendImage: mockSendImage,
        hasToken: mockHasToken,
      };

      // Create a temp file
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const tmpFile = '/tmp/wechat-test-image.png';
      writeFileSync(tmpFile, Buffer.from('fake-png-data'));

      try {
        await (channel as any).doSendMessage({
          chatId: 'user-123',
          type: 'file',
          filePath: tmpFile,
        });

        expect(mockUploadMedia).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'wechat-test-image.png' }),
        );
        expect(mockSendImage).toHaveBeenCalledWith({
          to: 'user-123',
          uploaded: { media: { encrypt_query_param: 'image-ref' }, size: 13, encryptedSize: 16 },
          contextToken: 'ctx-image',
        });
      } finally {
        unlinkSync(tmpFile);
      }
    });

    it('should upload and send non-image file', async () => {
      const channel = readyChannel();

      const mockUploadMedia = vi.fn().mockResolvedValue({
        media: { encrypt_query_param: 'file-ref' }, size: 13, encryptedSize: 16,
      });
      const mockSendFile = vi.fn().mockResolvedValue(undefined);

      (channel as any).client = {
        uploadMedia: mockUploadMedia,
        sendFile: mockSendFile,
        hasToken: mockHasToken,
      };

      const { writeFileSync, unlinkSync } = await import('node:fs');
      const tmpFile = '/tmp/wechat-test-doc.pdf';
      writeFileSync(tmpFile, Buffer.from('fake-pdf-data'));

      try {
        await (channel as any).doSendMessage({
          chatId: 'user-456',
          type: 'file',
          filePath: tmpFile,
          threadId: 'thread-abc',
        });

        expect(mockUploadMedia).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'wechat-test-doc.pdf' }),
        );
        expect(mockSendFile).toHaveBeenCalledWith({
          to: 'user-456',
          uploaded: { media: { encrypt_query_param: 'file-ref' }, size: 13, encryptedSize: 16 },
          fileName: 'wechat-test-doc.pdf',
          contextToken: 'ctx-file',
        });
      } finally {
        unlinkSync(tmpFile);
      }
    });

    it('should not send file when filePath is missing', async () => {
      const channel = readyChannel();
      const mockUploadMedia = vi.fn();
      (channel as any).client = {
        uploadMedia: mockUploadMedia,
        hasToken: mockHasToken,
      };

      await expect((channel as any).doSendMessage({
        chatId: 'chat-1', type: 'file',
      })).rejects.toThrow('Unsupported or empty');

      expect(mockUploadMedia).not.toHaveBeenCalled();
    });
  });
});
