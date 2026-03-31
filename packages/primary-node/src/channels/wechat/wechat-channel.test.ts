/**
 * Tests for WeChatChannel (MVP).
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3) - 3.3 Test Coverage
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';

// ---------------------------------------------------------------------------
// Mock: WeChatApiClient
// ---------------------------------------------------------------------------
const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockSetToken = vi.fn();
const mockHasToken = vi.fn().mockReturnValue(true);

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn().mockImplementation(() => ({
    sendText: mockSendText,
    setToken: mockSetToken,
    hasToken: mockHasToken,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: WeChatAuth — controllable via nextAuthResult / nextAuthBehaviour
// ---------------------------------------------------------------------------
let nextAuthResult: {
  success: boolean;
  token?: string;
  botId?: string;
  userId?: string;
  error?: string;
} = {
  success: true,
  token: 'mock-bot-token',
  botId: 'mock-bot-id',
  userId: 'mock-user-id',
};

let mockIsAuthenticating = false;
const mockAbort = vi.fn();
const mockAuthenticate = vi.fn();

vi.mock('./auth.js', () => ({
  WeChatAuth: vi.fn().mockImplementation(() => ({
    authenticate: (...args: unknown[]) => mockAuthenticate(...args),
    isAuthenticating: () => mockIsAuthenticating,
    abort: () => mockAbort(),
  })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('WeChatChannel', () => {
  beforeEach(() => {
    // Reset mock state
    mockSendText.mockResolvedValue(undefined);
    mockSetToken.mockReset();
    mockHasToken.mockReturnValue(true);
    mockAbort.mockReset();
    mockAuthenticate.mockReset();

    // Default: auth succeeds
    nextAuthResult = {
      success: true,
      token: 'mock-bot-token',
      botId: 'mock-bot-id',
      userId: 'mock-user-id',
    };
    mockIsAuthenticating = false;

    // Default: authenticate resolves to success
    mockAuthenticate.mockResolvedValue({ ...nextAuthResult });
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
    it('should return MVP capabilities (all false)', () => {
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

    it('should return API client after start with token', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();
      expect(channel.getApiClient()).toBeDefined();
      await channel.stop();
    });
  });

  describe('doStart (auth flow)', () => {
    it('should skip auth when token is pre-configured', async () => {
      const channel = new WeChatChannel({ token: 'pre-configured-token' });
      await channel.start();

      // Auth should NOT be called when token is provided
      expect(mockAuthenticate).not.toHaveBeenCalled();
      expect(channel.getApiClient()).toBeDefined();
      await channel.stop();
    });

    it('should run QR auth when no token is provided and succeed', async () => {
      mockAuthenticate.mockResolvedValue({
        success: true,
        token: 'auth-token-123',
        botId: 'bot-id-456',
        userId: 'user-id-789',
      });

      const channel = new WeChatChannel({});
      await channel.start();

      // Auth should be called
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
      // Token should be set on the client from auth result
      expect(mockSetToken).toHaveBeenCalledWith('auth-token-123');
      await channel.stop();
    });

    it('should throw when auth fails (success=false)', async () => {
      mockAuthenticate.mockResolvedValue({
        success: false,
        error: 'QR expired too many times',
        token: undefined,
      });

      const channel = new WeChatChannel({});
      await expect(channel.start()).rejects.toThrow(
        'WeChat authentication failed: QR expired too many times',
      );
    });

    it('should throw when auth succeeds but token is missing', async () => {
      mockAuthenticate.mockResolvedValue({
        success: true,
        token: undefined,
        botId: 'bot-id',
      });

      const channel = new WeChatChannel({});
      await expect(channel.start()).rejects.toThrow(
        'WeChat authentication failed: unknown error',
      );
    });

    it('should throw when auth fails with no error message', async () => {
      mockAuthenticate.mockResolvedValue({
        success: false,
        error: undefined,
        token: undefined,
      });

      const channel = new WeChatChannel({});
      await expect(channel.start()).rejects.toThrow(
        'WeChat authentication failed: unknown error',
      );
    });
  });

  describe('doStop', () => {
    it('should abort auth if authentication is in progress', async () => {
      mockAuthenticate.mockResolvedValue({
        success: true,
        token: 'auth-token',
        botId: 'bot-id',
      });

      const channel = new WeChatChannel({});
      await channel.start();

      // Simulate auth still in progress
      mockIsAuthenticating = true;

      await channel.stop();

      // abort should have been called
      expect(mockAbort).toHaveBeenCalledTimes(1);
      // Client should be cleaned up
      expect(channel.getApiClient()).toBeUndefined();
    });

    it('should not abort auth if not authenticating', async () => {
      mockAuthenticate.mockResolvedValue({
        success: true,
        token: 'auth-token',
        botId: 'bot-id',
      });

      const channel = new WeChatChannel({});
      await channel.start();

      // Auth is NOT in progress
      mockIsAuthenticating = false;

      await channel.stop();

      // abort should NOT have been called
      expect(mockAbort).not.toHaveBeenCalled();
      expect(channel.getApiClient()).toBeUndefined();
    });

    it('should handle stop when no auth exists (started with token)', async () => {
      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      await channel.stop();

      // Should not throw, client cleaned up
      expect(channel.getApiClient()).toBeUndefined();
    });
  });
});
