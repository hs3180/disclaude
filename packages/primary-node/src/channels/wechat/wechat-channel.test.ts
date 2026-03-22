/**
 * Tests for WeChat Channel.
 *
 * Tests the main channel implementation.
 * Uses mocked dependencies to avoid real network dependency.
 *
 * @see Issue #1023 - Unit tests should not depend on external environment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatChannel } from './wechat-channel.js';
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
    BaseChannel: actual.BaseChannel,
    DEFAULT_CHANNEL_CAPABILITIES: actual.DEFAULT_CHANNEL_CAPABILITIES,
  };
});

// Mock the API client
const mockApiClient = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => false),
  getToken: vi.fn(() => undefined),
  setToken: vi.fn(),
  getQRCode: vi.fn(),
  getQRCodeStatus: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('./api-client.js', () => ({
  WeChatApiClient: vi.fn(() => mockApiClient),
}));

// Mock the auth handler
const mockAuthHandler = vi.hoisted(() => {
  const handlers: Record<string, Set<(...args: unknown[]) => void>> = {};
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || new Set();
      handlers[event].add(handler);
    }),
    emit: (event: string, ...args: unknown[]) => {
      handlers[event]?.forEach((h) => h(...args));
    },
    cancelLogin: vi.fn(),
    startLogin: vi.fn(),
    getState: vi.fn(() => 'unauthenticated'),
    getCredentials: vi.fn(() => undefined),
    isAuthenticated: vi.fn(() => false),
  };
});

vi.mock('./auth.js', () => ({
  WeChatAuthHandler: vi.fn(() => mockAuthHandler),
}));

describe('WeChatChannel', () => {
  const defaultConfig: WeChatChannelConfig = {
    baseUrl: 'https://bot0.weidbot.qq.com',
  };

  let channel: WeChatChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient.isAuthenticated.mockReturnValue(false);
    mockApiClient.getToken.mockReturnValue(undefined);
  });

  afterEach(async () => {
    if (channel) {
      try {
        await channel.stop();
      } catch {
        // Ignore stop errors in cleanup
      }
    }
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      channel = new WeChatChannel(defaultConfig);
      expect(channel).toBeDefined();
      expect(channel.id).toBe('wechat');
      expect(channel.name).toBe('WeChat');
    });

    it('should create instance with custom id', () => {
      const config: WeChatChannelConfig = {
        ...defaultConfig,
        id: 'custom-wechat',
      };
      channel = new WeChatChannel(config);
      expect(channel.id).toBe('custom-wechat');
    });

    it('should create instance with token config', () => {
      const config: WeChatChannelConfig = {
        ...defaultConfig,
        token: 'test-token',
        botId: 'bot-123',
      };
      channel = new WeChatChannel(config);
      expect(channel).toBeDefined();
    });
  });

  describe('getCapabilities()', () => {
    it('should return correct capabilities for MVP', () => {
      channel = new WeChatChannel(defaultConfig);
      const capabilities = channel.getCapabilities();

      // MVP v1 capabilities
      expect(capabilities.supportsCard).toBe(false);
      expect(capabilities.supportsThread).toBe(false);
      expect(capabilities.supportsFile).toBe(false);
      expect(capabilities.supportsMarkdown).toBe(false);
      expect(capabilities.supportsMention).toBe(true);
      expect(capabilities.supportsUpdate).toBe(false);
      expect(capabilities.supportedMcpTools).toEqual(['send_text']);
    });
  });

  describe('doSendMessage', () => {
    it('should throw when not authenticated', async () => {
      channel = new WeChatChannel(defaultConfig);

      // Access protected method via type assertion
      await expect(
        (channel as unknown as { doSendMessage: (m: unknown) => Promise<void> }).doSendMessage({
          chatId: 'chat-123',
          type: 'text',
          text: 'Hello',
        })
      ).rejects.toThrow('Not authenticated');
    });

    it('should throw for card messages even when authenticated', async () => {
      mockApiClient.isAuthenticated.mockReturnValue(true);

      channel = new WeChatChannel(defaultConfig);

      await expect(
        (channel as unknown as { doSendMessage: (m: unknown) => Promise<void> }).doSendMessage({
          chatId: 'chat-123',
          type: 'card',
          card: {},
        })
      ).rejects.toThrow('Card messages are not supported by WeChat');
    });

    it('should throw for file messages even when authenticated', async () => {
      mockApiClient.isAuthenticated.mockReturnValue(true);

      channel = new WeChatChannel(defaultConfig);

      await expect(
        (channel as unknown as { doSendMessage: (m: unknown) => Promise<void> }).doSendMessage({
          chatId: 'chat-123',
          type: 'file',
          filePath: '/tmp/test.txt',
        })
      ).rejects.toThrow('File messages are not supported in MVP v1');
    });

    it('should throw for unsupported message types', async () => {
      mockApiClient.isAuthenticated.mockReturnValue(true);

      channel = new WeChatChannel(defaultConfig);

      await expect(
        (channel as unknown as { doSendMessage: (m: unknown) => Promise<void> }).doSendMessage({
          chatId: 'chat-123',
          type: 'unknown',
        })
      ).rejects.toThrow('Unsupported message type');
    });
  });

  describe('isAuthenticated', () => {
    it('should return false when not authenticated', () => {
      channel = new WeChatChannel(defaultConfig);
      expect(channel.isAuthenticated()).toBe(false);
    });

    it('should return true when api client is authenticated', () => {
      mockApiClient.isAuthenticated.mockReturnValue(true);
      channel = new WeChatChannel(defaultConfig);
      expect(channel.isAuthenticated()).toBe(true);
    });
  });

  describe('getCredentials', () => {
    it('should return undefined when not authenticated', () => {
      channel = new WeChatChannel(defaultConfig);
      expect(channel.getCredentials()).toBeUndefined();
    });

    it('should return credentials when available', () => {
      mockAuthHandler.getCredentials.mockReturnValue({ token: 'test-token', botId: 'bot-123' } as unknown as undefined);
      channel = new WeChatChannel(defaultConfig);
      expect(channel.getCredentials()).toEqual({ token: 'test-token', botId: 'bot-123' });
    });
  });

  describe('event forwarding', () => {
    it('should forward qrcode event from auth handler', () => {
      channel = new WeChatChannel(defaultConfig);

      const qrcodeHandler = vi.fn();
      channel.on('qrcode', qrcodeHandler);

      // Emit event from mock auth handler
      mockAuthHandler.emit('qrcode', { url: 'https://example.com/qr', id: 'qr-123' });

      expect(qrcodeHandler).toHaveBeenCalledWith({ url: 'https://example.com/qr', id: 'qr-123' });
    });

    it('should forward authenticated event from auth handler', () => {
      channel = new WeChatChannel(defaultConfig);

      const authenticatedHandler = vi.fn();
      channel.on('authenticated', authenticatedHandler);

      // Emit event from mock auth handler
      mockAuthHandler.emit('authenticated', { token: 'test-token', botId: 'bot-123' });

      expect(authenticatedHandler).toHaveBeenCalledWith({ token: 'test-token', botId: 'bot-123' });
    });
  });
});
