/**
 * Tests for WeChatChannel.
 *
 * Tests the WeChat channel implementation with mocked API client.
 * File sending tests are in api-client.test.ts (uploadMedia coverage).
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
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

// Store original fetch
const originalFetch = globalThis.fetch;

describe('WeChatChannel', () => {
  let WeChatChannel: typeof import('./wechat-channel.js').WeChatChannel;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mod = await import('./wechat-channel.js');
    WeChatChannel = mod.WeChatChannel;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('should create channel with default config', () => {
      const channel = new WeChatChannel();
      expect(channel).toBeDefined();
      expect(channel.id).toBe('wechat');
      expect(channel.name).toBe('WeChat');
    });

    it('should create channel with custom config', () => {
      const channel = new WeChatChannel({
        id: 'my-wechat',
        baseUrl: 'https://custom.example.com',
        routeTag: 'my-route',
        token: 'my-token',
      });
      expect(channel.id).toBe('my-wechat');
    });
  });

  describe('getCapabilities', () => {
    it('should return enhanced capabilities', () => {
      const channel = new WeChatChannel();
      const caps = channel.getCapabilities();

      expect(caps.supportsCard).toBe(false);
      expect(caps.supportsThread).toBe(true);
      expect(caps.supportsFile).toBe(true);
      expect(caps.supportsMarkdown).toBe(false);
      expect(caps.supportsMention).toBe(false);
      expect(caps.supportsUpdate).toBe(false);
      expect(caps.supportedMcpTools).toContain('send_text');
      expect(caps.supportedMcpTools).toContain('send_file');
    });
  });

  describe('lifecycle', () => {
    it('should start and stop with pre-configured token', async () => {
      // Mock fetch for getUpdates (used by message listener)
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });

      await channel.start();
      expect(channel.status).toBe('running');
      expect(channel.isHealthy()).toBe(true);

      await channel.stop();
      expect(channel.status).toBe('stopped');
    });

    it('should throw on send when not running', async () => {
      const channel = new WeChatChannel();
      await expect(channel.sendMessage({
        chatId: 'user-123',
        type: 'text',
        text: 'Hello',
      })).rejects.toThrow('not running');
    });
  });

  describe('doSendMessage', () => {
    it('should send text messages', async () => {
      // Mock fetch for getUpdates + sendText
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      const client = channel.getApiClient();
      const sendTextSpy = vi.spyOn(client!, 'sendText').mockResolvedValue(undefined);

      await channel.sendMessage({
        chatId: 'user-123',
        type: 'text',
        text: 'Hello!',
      });

      expect(sendTextSpy).toHaveBeenCalledWith({
        to: 'user-123',
        content: 'Hello!',
        contextToken: undefined,
      });

      await channel.stop();
    });

    it('should send text messages with threadId', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      const client = channel.getApiClient();
      const sendTextSpy = vi.spyOn(client!, 'sendText').mockResolvedValue(undefined);

      await channel.sendMessage({
        chatId: 'user-123',
        type: 'text',
        text: 'Reply in thread',
        threadId: 'ctx-token-abc',
      });

      expect(sendTextSpy).toHaveBeenCalledWith({
        to: 'user-123',
        content: 'Reply in thread',
        contextToken: 'ctx-token-abc',
      });

      await channel.stop();
    });

    it('should handle done type without error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      await channel.sendMessage({
        chatId: 'user-123',
        type: 'done',
      });

      await channel.stop();
    });

    it('should warn on unsupported message type', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      await channel.sendMessage({
        chatId: 'user-123',
        type: 'card',
        card: {},
      });

      expect(mockLogger.warn).toHaveBeenCalled();

      await channel.stop();
    });

    it('should throw when file message has no filePath', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      await expect(channel.sendMessage({
        chatId: 'user-123',
        type: 'file',
      })).rejects.toThrow('File path is required');

      await channel.stop();
    });
  });

  describe('message listening', () => {
    it('should start message listener on channel start', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      const listener = channel.getMessageListener();
      expect(listener).toBeDefined();
      expect(listener!.isListening()).toBe(true);

      await channel.stop();

      expect(listener!.isListening()).toBe(false);
    });

    it('should stop message listener on channel stop', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();
      await channel.stop();

      const listener = channel.getMessageListener();
      expect(listener).toBeUndefined();
    });
  });

  describe('checkHealth', () => {
    it('should return true when client has token and listener is active', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      expect(channel.isHealthy()).toBe(true);

      await channel.stop();
      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe('getApiClient', () => {
    it('should return undefined before start', () => {
      const channel = new WeChatChannel();
      expect(channel.getApiClient()).toBeUndefined();
    });

    it('should return client after start', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      const channel = new WeChatChannel({ token: 'test-token' });
      await channel.start();

      expect(channel.getApiClient()).toBeDefined();

      await channel.stop();
    });
  });
});
