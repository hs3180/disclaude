/**
 * Tests for Channel Message Router.
 *
 * Tests chatId-based channel detection and message routing.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChannelMessageRouter,
  ChannelType,
  initChannelMessageRouter,
  getChannelMessageRouter,
  resetChannelMessageRouter,
} from './channel-message-router.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe('ChannelMessageRouter', () => {
  let router: ChannelMessageRouter;
  let mockSendToFeishu: ReturnType<typeof vi.fn>;
  let mockSendToCli: ReturnType<typeof vi.fn>;
  let mockSendToRest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendToFeishu = vi.fn().mockResolvedValue(undefined);
    mockSendToCli = vi.fn().mockResolvedValue(undefined);
    mockSendToRest = vi.fn().mockResolvedValue(undefined);
    router = new ChannelMessageRouter({
      sendToFeishu: mockSendToFeishu,
      sendToCli: mockSendToCli,
      sendToRest: mockSendToRest,
    });
  });

  describe('detectChannel', () => {
    it('should detect Feishu group chat (oc_)', () => {
      expect(router.detectChannel('oc_abc123')).toBe(ChannelType.FEISHU);
    });

    it('should detect Feishu user chat (ou_)', () => {
      expect(router.detectChannel('ou_user456')).toBe(ChannelType.FEISHU);
    });

    it('should detect Feishu bot chat (on_)', () => {
      expect(router.detectChannel('on_bot789')).toBe(ChannelType.FEISHU);
    });

    it('should detect CLI chat (cli-)', () => {
      expect(router.detectChannel('cli-session-1')).toBe(ChannelType.CLI);
    });

    it('should detect REST chat (UUID format)', () => {
      expect(router.detectChannel('550e8400-e29b-41d4-a716-446655440000')).toBe(ChannelType.REST);
    });

    it('should detect REST chat (lowercase UUID)', () => {
      expect(router.detectChannel('550e8400-e29b-41d4-a716-446655440000')).toBe(ChannelType.REST);
    });

    it('should return UNKNOWN for unrecognized format', () => {
      expect(router.detectChannel('random_string')).toBe(ChannelType.UNKNOWN);
    });

    it('should return UNKNOWN for empty string', () => {
      expect(router.detectChannel('')).toBe(ChannelType.UNKNOWN);
    });

    it('should return UNKNOWN for non-string input', () => {
      expect(router.detectChannel(undefined as any)).toBe(ChannelType.UNKNOWN);
      expect(router.detectChannel(null as any)).toBe(ChannelType.UNKNOWN);
      expect(router.detectChannel(123 as any)).toBe(ChannelType.UNKNOWN);
    });
  });

  describe('route', () => {
    it('should route Feishu message to sendToFeishu', async () => {
      const result = await router.route('oc_abc123', { chatId: 'oc_abc123', type: 'text', text: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.FEISHU);
      expect(mockSendToFeishu).toHaveBeenCalledWith('oc_abc123', { chatId: 'oc_abc123', type: 'text', text: 'Hello' });
    });

    it('should route CLI message to sendToCli', async () => {
      const result = await router.route('cli-session-1', { chatId: 'cli-session-1', type: 'text', text: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.CLI);
      expect(mockSendToCli).toHaveBeenCalled();
    });

    it('should route REST message to sendToRest', async () => {
      const result = await router.route('550e8400-e29b-41d4-a716-446655440000', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'text',
        text: 'Hello',
      });
      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.REST);
      expect(mockSendToRest).toHaveBeenCalled();
    });

    it('should fail for unknown channel type', async () => {
      const result = await router.route('unknown_id', { chatId: 'unknown_id', type: 'text', text: 'Hello' });
      expect(result.success).toBe(false);
      expect(result.channelType).toBe(ChannelType.UNKNOWN);
      expect(result.error).toContain('Unknown chatId format');
    });

    it('should fail for REST when sendToRest is not configured', async () => {
      const noRestRouter = new ChannelMessageRouter({
        sendToFeishu: mockSendToFeishu,
      });

      const result = await noRestRouter.route('550e8400-e29b-41d4-a716-446655440000', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'text',
        text: 'Hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('REST channel sender not configured');
    });

    it('should handle routing errors', async () => {
      mockSendToFeishu.mockRejectedValue(new Error('Network error'));

      const result = await router.route('oc_abc123', { chatId: 'oc_abc123', type: 'text', text: 'Hello' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('routeText', () => {
    it('should route text message with correct format', async () => {
      const result = await router.routeText('oc_abc123', 'Hello world', 'thread_123');
      expect(result.success).toBe(true);
      expect(mockSendToFeishu).toHaveBeenCalledWith('oc_abc123', {
        chatId: 'oc_abc123',
        type: 'text',
        text: 'Hello world',
        threadId: 'thread_123',
      });
    });
  });

  describe('routeCard', () => {
    it('should route card message with correct format', async () => {
      const card = { header: { title: 'Test' }, elements: [] };
      const result = await router.routeCard('oc_abc123', card, 'thread_456');
      expect(result.success).toBe(true);
      expect(mockSendToFeishu).toHaveBeenCalledWith('oc_abc123', {
        chatId: 'oc_abc123',
        type: 'card',
        card,
        threadId: 'thread_456',
      });
    });
  });

  describe('isFeishuChat / isCliChat / isRestChat', () => {
    it('should correctly identify Feishu chats', () => {
      expect(router.isFeishuChat('oc_group')).toBe(true);
      expect(router.isFeishuChat('ou_user')).toBe(true);
      expect(router.isFeishuChat('cli-1')).toBe(false);
    });

    it('should correctly identify CLI chats', () => {
      expect(router.isCliChat('cli-session')).toBe(true);
      expect(router.isCliChat('oc_group')).toBe(false);
    });

    it('should correctly identify REST chats', () => {
      expect(router.isRestChat('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(router.isRestChat('oc_group')).toBe(false);
    });
  });

  describe('getChannelTypeName', () => {
    it('should return capitalized channel type name', () => {
      expect(router.getChannelTypeName('oc_group')).toBe('Feishu');
      expect(router.getChannelTypeName('cli-1')).toBe('Cli');
      expect(router.getChannelTypeName('550e8400-e29b-41d4-a716-446655440000')).toBe('Rest');
      expect(router.getChannelTypeName('unknown')).toBe('Unknown');
    });
  });

  describe('broadcast', () => {
    it('should send to all registered channels', async () => {
      const mockChannel1 = { id: 'ch1', sendMessage: vi.fn().mockResolvedValue(undefined) };
      const mockChannel2 = { id: 'ch2', sendMessage: vi.fn().mockResolvedValue(undefined) };

      const broadcastRouter = new ChannelMessageRouter({
        sendToFeishu: mockSendToFeishu,
        channels: new Map([['ch1', mockChannel1 as any], ['ch2', mockChannel2 as any]]),
      });

      await broadcastRouter.broadcast({ chatId: 'oc_test', type: 'text', text: 'Broadcast' });

      expect(mockChannel1.sendMessage).toHaveBeenCalled();
      expect(mockChannel2.sendMessage).toHaveBeenCalled();
    });

    it('should handle broadcast with no channels', async () => {
      const noChannelRouter = new ChannelMessageRouter({
        sendToFeishu: mockSendToFeishu,
        channels: new Map(),
      });

      await noChannelRouter.broadcast({ chatId: 'oc_test', type: 'text', text: 'Broadcast' });
      // Should not throw
    });

    it('should continue broadcasting when some channels fail', async () => {
      const mockChannel1 = { id: 'ch1', sendMessage: vi.fn().mockRejectedValue(new Error('Fail')) };
      const mockChannel2 = { id: 'ch2', sendMessage: vi.fn().mockResolvedValue(undefined) };

      const broadcastRouter = new ChannelMessageRouter({
        sendToFeishu: mockSendToFeishu,
        channels: new Map([['ch1', mockChannel1 as any], ['ch2', mockChannel2 as any]]),
      });

      await broadcastRouter.broadcast({ chatId: 'oc_test', type: 'text', text: 'Broadcast' });
      expect(mockChannel2.sendMessage).toHaveBeenCalled();
    });
  });
});

describe('Global channel message router', () => {
  afterEach(() => {
    resetChannelMessageRouter();
  });

  describe('initChannelMessageRouter', () => {
    it('should initialize and return a router', () => {
      const router = initChannelMessageRouter({
        sendToFeishu: vi.fn().mockResolvedValue(undefined),
      });
      expect(router).toBeInstanceOf(ChannelMessageRouter);
    });
  });

  describe('getChannelMessageRouter', () => {
    it('should return the initialized router', () => {
      initChannelMessageRouter({
        sendToFeishu: vi.fn().mockResolvedValue(undefined),
      });
      expect(getChannelMessageRouter()).toBeInstanceOf(ChannelMessageRouter);
    });

    it('should throw when not initialized', () => {
      expect(() => getChannelMessageRouter()).toThrow('not initialized');
    });
  });

  describe('resetChannelMessageRouter', () => {
    it('should clear the global router', () => {
      initChannelMessageRouter({
        sendToFeishu: vi.fn().mockResolvedValue(undefined),
      });
      resetChannelMessageRouter();
      expect(() => getChannelMessageRouter()).toThrow('not initialized');
    });
  });
});
