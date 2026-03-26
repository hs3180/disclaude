/**
 * Tests for WeChatChannel.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';

// Mock functions - declared before vi.mock for proper hoisting
const mockSendText = vi.fn();
const mockSetToken = vi.fn();
const mockHasToken = vi.fn();
const mockGetUpdates = vi.fn();

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn().mockImplementation(() => ({
    sendText: mockSendText,
    setToken: mockSetToken,
    hasToken: mockHasToken,
    getUpdates: mockGetUpdates,
  })),
}));

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

const mockListenerStart = vi.fn();
const mockListenerStop = vi.fn();
const mockListenerIsRunning = vi.fn();

vi.mock('./message-listener.js', () => ({
  WeChatMessageListener: vi.fn().mockImplementation(() => ({
    start: mockListenerStart,
    stop: mockListenerStop,
    isRunning: mockListenerIsRunning,
  })),
}));

describe('WeChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set mock implementations after clearAllMocks
    mockSendText.mockResolvedValue(undefined);
    mockSetToken.mockImplementation(() => {});
    mockHasToken.mockReturnValue(true);
    mockGetUpdates.mockResolvedValue({ ret: 0, msg_list: [] });
    mockListenerStart.mockImplementation(() => {});
    mockListenerStop.mockResolvedValue(undefined);
    mockListenerIsRunning.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    it('should return capabilities (all false except send_text)', () => {
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
      await channel.start();

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

      await channel.stop();
    });

    it('should send text with threadId as contextToken', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      // Set client directly (bypass start) for isolated doSendMessage test
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

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'text',
        text: '',
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should ignore unsupported message types', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = { sendText: mockSendText, hasToken: mockHasToken };

      await (channel as any).doSendMessage({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/tmp/test.txt',
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

  describe('checkHealth', () => {
    it('should return true when client has token and listener is running', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      expect((channel as any).checkHealth()).toBe(true);

      await channel.stop();
    });

    it('should return false when listener is not running', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      mockListenerIsRunning.mockReturnValue(false);
      expect((channel as any).checkHealth()).toBe(false);

      await channel.stop();
    });

    it('should return false when client has no token', () => {
      const channel = new WeChatChannel();
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

  describe('message listening (Issue #1556)', () => {
    it('should start message listener after authentication', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      expect(mockListenerStart).toHaveBeenCalled();
      await channel.stop();
    });

    it('should stop message listener on channel stop', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();
      await channel.stop();

      expect(mockListenerStop).toHaveBeenCalled();
    });

    it('should not start listener when client has no token', async () => {
      mockHasToken.mockReturnValue(false);
      const channel = new WeChatChannel({ token: 'test-token' });
      (channel as any).client = {
        sendText: mockSendText,
        hasToken: mockHasToken,
        getUpdates: mockGetUpdates,
      };

      await (channel as any).doStart();

      expect(mockListenerStart).not.toHaveBeenCalled();
      await channel.stop();
    });

    it('should not start listener when client has no token after auth', async () => {
      // Make auth fail to simulate no-token scenario
      const { WeChatAuth } = await import('./auth.js');
      const authModule = vi.mocked(WeChatAuth);
      authModule.mockImplementationOnce(() => ({
        authenticate: vi.fn().mockResolvedValue({
          success: false,
          error: 'Auth failed',
        }),
        isAuthenticating: vi.fn().mockReturnValue(false),
        abort: vi.fn(),
      } as any));

      const channel = new WeChatChannel();
      try {
        await (channel as any).doStart();
      } catch {
        // Expected: auth failure throws
      }

      // Listener should not start since auth failed and client has no token
      expect(mockListenerStart).not.toHaveBeenCalled();
    });
  });

  describe('getMessageListener', () => {
    it('should return undefined when not started', () => {
      const channel = new WeChatChannel();
      expect(channel.getMessageListener()).toBeUndefined();
    });
  });
});
