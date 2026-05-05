/**
 * Tests for WeChatChannel.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1 + 3.2)
 */



import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';

// Mock the API client
const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockSetToken = vi.fn();
const mockHasToken = vi.fn().mockReturnValue(true);
const mockGetUpdates = vi.fn().mockResolvedValue([]);
const mockUploadMedia = vi.fn().mockResolvedValue({ url: 'https://cdn.example.com/uploaded.png', fileKey: 'key-1' });
const mockSendImage = vi.fn().mockResolvedValue(undefined);
const mockSendFile = vi.fn().mockResolvedValue(undefined);

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn().mockImplementation(() => ({
    sendText: mockSendText,
    setToken: mockSetToken,
    hasToken: mockHasToken,
    getUpdates: mockGetUpdates,
    uploadMedia: mockUploadMedia,
    sendImage: mockSendImage,
    sendFile: mockSendFile,
  })),
}));

// Mock fs for file reading
const mockReadFileSync = vi.fn().mockReturnValue(Buffer.from('fake-file-data'));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  };
});

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    basename: (p: string) => p.split('/').pop() ?? p,
  };
});

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

// Mock the message listener module
const mockStart = vi.fn();
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockIsListening = vi.fn().mockReturnValue(true);

vi.mock('./message-listener.js', () => ({
  WeChatMessageListener: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    isListening: mockIsListening,
  })),
  MessageProcessor: undefined,
}));

describe('WeChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasToken.mockReturnValue(true);
    mockSendText.mockResolvedValue(undefined);
    mockGetUpdates.mockResolvedValue([]);
    mockIsListening.mockReturnValue(true);
    mockUploadMedia.mockResolvedValue({ url: 'https://cdn.example.com/uploaded.png', fileKey: 'key-1' });
    mockSendImage.mockResolvedValue(undefined);
    mockSendFile.mockResolvedValue(undefined);
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
      await expect(
        (channel as any).doSendMessage({ chatId: 'test', type: 'text', text: 'hello' })
      ).rejects.toThrow('WeChat client not initialized');
    });

    it('should send text messages via API client', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        hasToken: mockHasToken,
        uploadMedia: mockUploadMedia,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
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
        hasToken: mockHasToken,
        uploadMedia: mockUploadMedia,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
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
        hasToken: mockHasToken,
        uploadMedia: mockUploadMedia,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
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
        hasToken: mockHasToken,
        uploadMedia: mockUploadMedia,
        sendImage: mockSendImage,
        sendFile: mockSendFile,
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
        hasToken: mockHasToken,
      };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: '',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });

    // Issue #1556 Phase 3.2 — File sending via CDN
    describe('file sending', () => {
      it('should upload and send image files', async () => {
        const channel = new WeChatChannel({ token: 'test-token' });
        (channel as any).client = {
          sendText: mockSendText,
          hasToken: mockHasToken,
          uploadMedia: mockUploadMedia,
          sendImage: mockSendImage,
          sendFile: mockSendFile,
        };

        await (channel as any).doSendMessage({
          chatId: 'chat-1',
          type: 'file',
          filePath: '/tmp/photo.png',
        });

        expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/photo.png');
        expect(mockUploadMedia).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'photo.png' }),
        );
        expect(mockSendImage).toHaveBeenCalledWith({
          to: 'chat-1',
          imageUrl: 'https://cdn.example.com/uploaded.png',
          contextToken: undefined,
        });
        expect(mockSendFile).not.toHaveBeenCalled();
      });

      it('should upload and send non-image files', async () => {
        const channel = new WeChatChannel({ token: 'test-token' });
        (channel as any).client = {
          sendText: mockSendText,
          hasToken: mockHasToken,
          uploadMedia: mockUploadMedia,
          sendImage: mockSendImage,
          sendFile: mockSendFile,
        };

        await (channel as any).doSendMessage({
          chatId: 'chat-1',
          type: 'file',
          filePath: '/tmp/document.pdf',
        });

        expect(mockUploadMedia).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'document.pdf' }),
        );
        expect(mockSendFile).toHaveBeenCalledWith({
          to: 'chat-1',
          fileUrl: 'https://cdn.example.com/uploaded.png',
          fileName: 'document.pdf',
          contextToken: undefined,
        });
        expect(mockSendImage).not.toHaveBeenCalled();
      });

      it('should send file with threadId as contextToken', async () => {
        const channel = new WeChatChannel({ token: 'test-token' });
        (channel as any).client = {
          sendText: mockSendText,
          hasToken: mockHasToken,
          uploadMedia: mockUploadMedia,
          sendImage: mockSendImage,
          sendFile: mockSendFile,
        };

        await (channel as any).doSendMessage({
          chatId: 'chat-1',
          type: 'file',
          filePath: '/tmp/report.pdf',
          threadId: 'thread-abc',
        });

        expect(mockSendFile).toHaveBeenCalledWith(
          expect.objectContaining({ contextToken: 'thread-abc' }),
        );
      });

      it('should detect jpg files as images', async () => {
        const channel = new WeChatChannel({ token: 'test-token' });
        (channel as any).client = {
          sendText: mockSendText,
          hasToken: mockHasToken,
          uploadMedia: mockUploadMedia,
          sendImage: mockSendImage,
          sendFile: mockSendFile,
        };

        await (channel as any).doSendMessage({
          chatId: 'chat-1',
          type: 'file',
          filePath: '/tmp/pic.jpg',
        });

        expect(mockSendImage).toHaveBeenCalled();
        expect(mockSendFile).not.toHaveBeenCalled();
      });

      it('should detect gif files as images', async () => {
        const channel = new WeChatChannel({ token: 'test-token' });
        (channel as any).client = {
          sendText: mockSendText,
          hasToken: mockHasToken,
          uploadMedia: mockUploadMedia,
          sendImage: mockSendImage,
          sendFile: mockSendFile,
        };

        await (channel as any).doSendMessage({
          chatId: 'chat-1',
          type: 'file',
          filePath: '/tmp/anim.gif',
        });

        expect(mockSendImage).toHaveBeenCalled();
        expect(mockSendFile).not.toHaveBeenCalled();
      });

      it('should detect webp files as images', async () => {
        const channel = new WeChatChannel({ token: 'test-token' });
        (channel as any).client = {
          sendText: mockSendText,
          hasToken: mockHasToken,
          uploadMedia: mockUploadMedia,
          sendImage: mockSendImage,
          sendFile: mockSendFile,
        };

        await (channel as any).doSendMessage({
          chatId: 'chat-1',
          type: 'file',
          filePath: '/tmp/pic.webp',
        });

        expect(mockSendImage).toHaveBeenCalled();
        expect(mockSendFile).not.toHaveBeenCalled();
      });
    });

    it('should ignore unsupported message types', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
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
    it('should return true when client has token and listener is active', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mockHasToken };
      (channel as any).messageListener = { isListening: mockIsListening };
      mockHasToken.mockReturnValue(true);
      mockIsListening.mockReturnValue(true);
      expect((channel as any).checkHealth()).toBe(true);
    });

    it('should return false when client has no token', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mockHasToken };
      (channel as any).messageListener = { isListening: mockIsListening };
      mockHasToken.mockReturnValue(false);
      expect((channel as any).checkHealth()).toBe(false);
    });

    it('should return false when message listener is not active', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mockHasToken };
      (channel as any).messageListener = { isListening: mockIsListening };
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
      const channel = new WeChatChannel({ token: 'test-token' });
      const mockListener = { stop: vi.fn().mockResolvedValue(undefined) };
      (channel as any).messageListener = mockListener;

      await (channel as any).doStop();

      expect(mockListener.stop).toHaveBeenCalledTimes(1);
      expect((channel as any).messageListener).toBeUndefined();
    });
  });
});
