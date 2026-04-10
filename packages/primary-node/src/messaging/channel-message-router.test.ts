/**
 * Tests for ChannelMessageRouter
 *
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChannelMessageRouter,
  ChannelType,
  initChannelMessageRouter,
  getChannelMessageRouter,
  resetChannelMessageRouter,
} from './channel-message-router.js';

describe('ChannelMessageRouter', () => {
  let sendToFeishu: ReturnType<typeof vi.fn>;
  let sendToCli: ReturnType<typeof vi.fn>;
  let sendToRest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendToFeishu = vi.fn().mockResolvedValue(undefined);
    sendToCli = vi.fn().mockResolvedValue(undefined);
    sendToRest = vi.fn().mockResolvedValue(undefined);
    resetChannelMessageRouter();
  });

  afterEach(() => {
    resetChannelMessageRouter();
  });

  function createRouter(): ChannelMessageRouter {
    return new ChannelMessageRouter({
      sendToFeishu,
      sendToCli,
      sendToRest,
    });
  }

  describe('detectChannel', () => {
    it('should detect Feishu group chat (oc_)', () => {
      const router = createRouter();
      expect(router.detectChannel('oc_abc123')).toBe(ChannelType.FEISHU);
    });

    it('should detect Feishu user chat (ou_)', () => {
      const router = createRouter();
      expect(router.detectChannel('ou_user123')).toBe(ChannelType.FEISHU);
    });

    it('should detect Feishu bot chat (on_)', () => {
      const router = createRouter();
      expect(router.detectChannel('on_bot123')).toBe(ChannelType.FEISHU);
    });

    it('should detect CLI chat (cli-)', () => {
      const router = createRouter();
      expect(router.detectChannel('cli-session-1')).toBe(ChannelType.CLI);
    });

    it('should detect REST chat (UUID format)', () => {
      const router = createRouter();
      expect(router.detectChannel('550e8400-e29b-41d4-a716-446655440000')).toBe(ChannelType.REST);
    });

    it('should return UNKNOWN for unrecognized format', () => {
      const router = createRouter();
      expect(router.detectChannel('unknown-chat-id')).toBe(ChannelType.UNKNOWN);
    });

    it('should return UNKNOWN for empty string', () => {
      const router = createRouter();
      expect(router.detectChannel('')).toBe(ChannelType.UNKNOWN);
    });

    it('should return UNKNOWN for null input', () => {
      const router = createRouter();
      expect(router.detectChannel(null as any)).toBe(ChannelType.UNKNOWN);
    });
  });

  describe('route', () => {
    it('should route to Feishu for oc_ chatId', async () => {
      const router = createRouter();
      const result = await router.route('oc_chat1', {
        chatId: 'oc_chat1',
        type: 'text',
        text: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.FEISHU);
      expect(sendToFeishu).toHaveBeenCalledWith('oc_chat1', expect.objectContaining({ type: 'text' }));
    });

    it('should route to CLI for cli- chatId', async () => {
      const router = createRouter();
      const result = await router.route('cli-session1', {
        chatId: 'cli-session1',
        type: 'text',
        text: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.CLI);
      expect(sendToCli).toHaveBeenCalled();
    });

    it('should route to REST for UUID chatId', async () => {
      const router = createRouter();
      const result = await router.route('550e8400-e29b-41d4-a716-446655440000', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'text',
        text: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.REST);
      expect(sendToRest).toHaveBeenCalled();
    });

    it('should return error for unknown chatId', async () => {
      const router = createRouter();
      const result = await router.route('unknown_id', {
        chatId: 'unknown_id',
        type: 'text',
        text: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.channelType).toBe(ChannelType.UNKNOWN);
      expect(result.error).toContain('Unknown chatId format');
    });

    it('should return error when REST sender not configured', async () => {
      const router = new ChannelMessageRouter({
        sendToFeishu,
        sendToCli,
        // No sendToRest
      });

      const result = await router.route('550e8400-e29b-41d4-a716-446655440000', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'text',
        text: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('REST channel sender not configured');
    });

    it('should handle routing errors', async () => {
      sendToFeishu.mockRejectedValue(new Error('Connection failed'));
      const router = createRouter();

      const result = await router.route('oc_chat1', {
        chatId: 'oc_chat1',
        type: 'text',
        text: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection failed');
    });

    it('should use default CLI sender when not provided', async () => {
      const router = new ChannelMessageRouter({
        sendToFeishu,
        // No sendToCli
      });

      const result = await router.route('cli-session1', {
        chatId: 'cli-session1',
        type: 'text',
        text: 'Hello CLI',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('routeText', () => {
    it('should route text message', async () => {
      const router = createRouter();
      const result = await router.routeText('oc_chat1', 'Hello');
      expect(result.success).toBe(true);
    });
  });

  describe('routeCard', () => {
    it('should route card message', async () => {
      const router = createRouter();
      const result = await router.routeCard('oc_chat1', { title: 'Card' });
      expect(result.success).toBe(true);
    });
  });

  describe('broadcast', () => {
    it('should broadcast to all channels', async () => {
      const channels = new Map();
      const mockChannel1 = {
        id: 'ch1',
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannel2 = {
        id: 'ch2',
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      channels.set('ch1', mockChannel1);
      channels.set('ch2', mockChannel2);

      const router = new ChannelMessageRouter({
        sendToFeishu,
        channels,
      });

      await router.broadcast({
        chatId: 'broadcast',
        type: 'text',
        text: 'Broadcast message',
      });

      expect(mockChannel1.sendMessage).toHaveBeenCalled();
      expect(mockChannel2.sendMessage).toHaveBeenCalled();
    });

    it('should handle no channels gracefully', async () => {
      const router = createRouter();
      // No channels registered
      await expect(router.broadcast({
        chatId: 'broadcast',
        type: 'text',
        text: 'Test',
      })).resolves.toBeUndefined();
    });

    it('should handle channel errors during broadcast', async () => {
      const channels = new Map();
      const errorChannel = {
        id: 'error-ch',
        sendMessage: vi.fn().mockRejectedValue(new Error('Channel error')),
      };
      channels.set('error-ch', errorChannel);

      const router = new ChannelMessageRouter({
        sendToFeishu,
        channels,
      });

      // Should not throw
      await router.broadcast({
        chatId: 'broadcast',
        type: 'text',
        text: 'Test',
      });
    });
  });

  describe('convenience methods', () => {
    it('isFeishuChat should detect Feishu chats', () => {
      const router = createRouter();
      expect(router.isFeishuChat('oc_chat1')).toBe(true);
      expect(router.isFeishuChat('cli-session')).toBe(false);
    });

    it('isCliChat should detect CLI chats', () => {
      const router = createRouter();
      expect(router.isCliChat('cli-session')).toBe(true);
      expect(router.isCliChat('oc_chat1')).toBe(false);
    });

    it('isRestChat should detect REST chats', () => {
      const router = createRouter();
      expect(router.isRestChat('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(router.isRestChat('oc_chat1')).toBe(false);
    });

    it('getChannelTypeName should return capitalized name', () => {
      const router = createRouter();
      expect(router.getChannelTypeName('oc_chat1')).toBe('Feishu');
      expect(router.getChannelTypeName('cli-session')).toBe('Cli');
      expect(router.getChannelTypeName('unknown')).toBe('Unknown');
    });
  });
});

describe('Global ChannelMessageRouter', () => {
  afterEach(() => {
    resetChannelMessageRouter();
  });

  it('should throw when not initialized', () => {
    expect(() => getChannelMessageRouter()).toThrow('not initialized');
  });

  it('should return initialized router', () => {
    const router = initChannelMessageRouter({
      sendToFeishu: vi.fn(),
    });
    expect(getChannelMessageRouter()).toBe(router);
  });

  it('should reset global router', () => {
    initChannelMessageRouter({ sendToFeishu: vi.fn() });
    resetChannelMessageRouter();
    expect(() => getChannelMessageRouter()).toThrow();
  });
});
