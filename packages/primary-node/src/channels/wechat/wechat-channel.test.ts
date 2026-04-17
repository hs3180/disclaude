/**
 * Tests for WeChatChannel.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1, 3.2)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';

// Use vi.hoisted for all mocks used inside vi.mock factories
const mocks = vi.hoisted(() => {
  const mockSendText = vi.fn().mockResolvedValue(undefined);
  const mockSetToken = vi.fn();
  const mockHasToken = vi.fn().mockReturnValue(true);
  const mockGetUpdates = vi.fn().mockResolvedValue([]);
  const mockSendTyping = vi.fn().mockResolvedValue(undefined);
  const mockStart = vi.fn();
  const mockStop = vi.fn().mockResolvedValue(undefined);
  const mockIsListening = vi.fn().mockReturnValue(true);

  return {
    apiClient: { sendText: mockSendText, setToken: mockSetToken, hasToken: mockHasToken, getUpdates: mockGetUpdates, sendTyping: mockSendTyping },
    listener: { start: mockStart, stop: mockStop, isListening: mockIsListening },
  };
});

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn().mockImplementation(() => mocks.apiClient),
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

vi.mock('./message-listener.js', () => ({
  WeChatMessageListener: vi.fn().mockImplementation(() => ({
    start: mocks.listener.start,
    stop: mocks.listener.stop,
    isListening: mocks.listener.isListening,
  })),
  MessageProcessor: undefined,
}));

describe('WeChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiClient.hasToken.mockReturnValue(true);
    mocks.apiClient.sendText.mockResolvedValue(undefined);
    mocks.apiClient.getUpdates.mockResolvedValue([]);
    mocks.apiClient.sendTyping.mockResolvedValue(undefined);
    mocks.listener.isListening.mockReturnValue(true);
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
        supportsFile: false,
        supportsMarkdown: false,
        supportsMention: false,
        supportsUpdate: false,
        supportedMcpTools: ['send_text'],
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
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello WeChat!',
      });

      expect(mocks.apiClient.sendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: 'Hello WeChat!',
        contextToken: undefined,
      });
    });

    it('should send text with threadId as contextToken', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello in thread',
        threadId: 'thread-123',
      });

      expect(mocks.apiClient.sendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: 'Hello in thread',
        contextToken: 'thread-123',
      });
    });

    it('should downgrade card messages to JSON text', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      const card = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'test' } }] };
      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'card',
        card,
      });

      expect(mocks.apiClient.sendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: JSON.stringify(card),
        contextToken: undefined,
      });
    });

    it('should downgrade card with threadId', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      const card = { elements: [] };
      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'card',
        card,
        threadId: 'thread-456',
      });

      expect(mocks.apiClient.sendText).toHaveBeenCalledWith({
        to: 'chat-1',
        content: JSON.stringify(card),
        contextToken: 'thread-456',
      });
    });

    it('should not send empty text messages', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: '',
      });

      expect(mocks.apiClient.sendText).not.toHaveBeenCalled();
    });

    it('should ignore unsupported message types', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/tmp/test.txt',
      });

      expect(mocks.apiClient.sendText).not.toHaveBeenCalled();
    });

    it('should ignore done signal type', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mocks.apiClient.sendText, hasToken: mocks.apiClient.hasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'done',
      });

      expect(mocks.apiClient.sendText).not.toHaveBeenCalled();
    });
  });

  describe('checkHealth', () => {
    it('should return true when client has token and listener is active', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mocks.apiClient.hasToken };
      (channel as any).messageListener = { isListening: mocks.listener.isListening };
      mocks.apiClient.hasToken.mockReturnValue(true);
      mocks.listener.isListening.mockReturnValue(true);
      expect((channel as any).checkHealth()).toBe(true);
    });

    it('should return false when client has no token', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mocks.apiClient.hasToken };
      (channel as any).messageListener = { isListening: mocks.listener.isListening };
      mocks.apiClient.hasToken.mockReturnValue(false);
      expect((channel as any).checkHealth()).toBe(false);
    });

    it('should return false when message listener is not active', () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { hasToken: mocks.apiClient.hasToken };
      (channel as any).messageListener = { isListening: mocks.listener.isListening };
      mocks.apiClient.hasToken.mockReturnValue(true);
      mocks.listener.isListening.mockReturnValue(false);
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

  describe('typing indicator (Issue #1556 Phase 3.2)', () => {
    it('should send typing indicator when message processor receives a message', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });

      // Capture the processor callback passed to WeChatMessageListener
      let capturedProcessor: any;
      const { WeChatMessageListener } = await import('./message-listener.js');
      vi.mocked(WeChatMessageListener).mockImplementation(((_client: any, processor: any) => {
        capturedProcessor = processor;
        return { start: mocks.listener.start, stop: mocks.listener.stop, isListening: mocks.listener.isListening } as any;
      }));

      await (channel as any).doStart();

      // Add sendTyping spy to the client instance created by doStart
      const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
      (channel as any).client.sendTyping = sendTypingSpy;

      // Simulate incoming message through the captured processor
      const incomingMessage = {
        messageId: 'msg-1',
        chatId: 'user-123',
        userId: 'user-123',
        content: 'Hello!',
        messageType: 'text',
        timestamp: Date.now(),
      };

      // emitMessage is a BaseChannel method — mock it to capture the call
      const emitSpy = vi.fn().mockResolvedValue(undefined);
      (channel as any).emitMessage = emitSpy;

      await capturedProcessor(incomingMessage);

      // Typing indicator should be sent before emitMessage
      expect(sendTypingSpy).toHaveBeenCalledWith({
        to: 'user-123',
        contextToken: undefined,
      });
      expect(emitSpy).toHaveBeenCalledWith(incomingMessage);
    });

    it('should include threadId as contextToken in typing indicator', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });

      let capturedProcessor: any;
      const { WeChatMessageListener } = await import('./message-listener.js');
      vi.mocked(WeChatMessageListener).mockImplementation(((_client: any, processor: any) => {
        capturedProcessor = processor;
        return { start: mocks.listener.start, stop: mocks.listener.stop, isListening: mocks.listener.isListening } as any;
      }));

      await (channel as any).doStart();

      const sendTypingSpy = vi.fn().mockResolvedValue(undefined);
      (channel as any).client.sendTyping = sendTypingSpy;

      const incomingMessage = {
        messageId: 'msg-2',
        chatId: 'user-456',
        userId: 'user-456',
        content: 'Thread msg',
        messageType: 'text',
        timestamp: Date.now(),
        threadId: 'thread-789',
      };

      const emitSpy = vi.fn().mockResolvedValue(undefined);
      (channel as any).emitMessage = emitSpy;

      await capturedProcessor(incomingMessage);

      expect(sendTypingSpy).toHaveBeenCalledWith({
        to: 'user-456',
        contextToken: 'thread-789',
      });
    });
  });
});
