/**
 * Tests for Channel Message Router.
 *
 * Issue #513: Multi-channel message routing layer (Phase 1)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ChannelMessageRouter,
  ChannelType,
  initChannelMessageRouter,
  getChannelMessageRouter,
  resetChannelMessageRouter,
  type ChannelMessageRouterOptions,
} from './channel-message-router.js';
import type { OutgoingMessage, IChannel } from '@disclaude/primary-node';

describe('ChannelMessageRouter', () => {
  let router: ChannelMessageRouter;
  let mockSendToFeishu: ReturnType<typeof vi.fn>;
  let mockSendToCli: ReturnType<typeof vi.fn>;
  let mockSendToRest: ReturnType<typeof vi.fn>;

  const createRouter = (options?: Partial<ChannelMessageRouterOptions>): ChannelMessageRouter => {
    return new ChannelMessageRouter({
      sendToFeishu: mockSendToFeishu,
      sendToCli: mockSendToCli,
      sendToRest: mockSendToRest,
      ...options,
    });
  };

  beforeEach(() => {
    mockSendToFeishu = vi.fn().mockResolvedValue(undefined);
    mockSendToCli = vi.fn().mockResolvedValue(undefined);
    mockSendToRest = vi.fn().mockResolvedValue(undefined);
    router = createRouter();
    resetChannelMessageRouter();
  });

  afterEach(() => {
    resetChannelMessageRouter();
  });

  describe('detectChannel', () => {
    it('should detect Feishu group chat (oc_)', () => {
      expect(router.detectChannel('oc_abc123def456')).toBe(ChannelType.FEISHU);
    });

    it('should detect Feishu user chat (ou_)', () => {
      expect(router.detectChannel('ou_xyz789')).toBe(ChannelType.FEISHU);
    });

    it('should detect Feishu bot chat (on_)', () => {
      expect(router.detectChannel('on_bot123')).toBe(ChannelType.FEISHU);
    });

    it('should detect CLI chat', () => {
      expect(router.detectChannel('cli-test123')).toBe(ChannelType.CLI);
      expect(router.detectChannel('cli-abc')).toBe(ChannelType.CLI);
    });

    it('should detect REST chat (UUID format)', () => {
      expect(router.detectChannel('123e4567-e89b-12d3-a456-426614174000')).toBe(ChannelType.REST);
      expect(router.detectChannel('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(ChannelType.REST);
    });

    it('should return UNKNOWN for unrecognized formats', () => {
      expect(router.detectChannel('random-id')).toBe(ChannelType.UNKNOWN);
      expect(router.detectChannel('')).toBe(ChannelType.UNKNOWN);
      expect(router.detectChannel('invalid')).toBe(ChannelType.UNKNOWN);
    });

    it('should handle null/undefined gracefully', () => {
      expect(router.detectChannel('')).toBe(ChannelType.UNKNOWN);
    });
  });

  describe('route', () => {
    const textMessage: OutgoingMessage = {
      chatId: 'oc_test',
      type: 'text',
      text: 'Hello World',
    };

    it('should route to Feishu for oc_ chatIds', async () => {
      const result = await router.route('oc_test', textMessage);

      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.FEISHU);
      expect(mockSendToFeishu).toHaveBeenCalledWith('oc_test', textMessage);
    });

    it('should route to CLI for cli- chatIds', async () => {
      const result = await router.route('cli-test', textMessage);

      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.CLI);
      expect(mockSendToCli).toHaveBeenCalledWith('cli-test', textMessage);
    });

    it('should route to REST for UUID chatIds', async () => {
      const uuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = await router.route(uuid, { ...textMessage, chatId: uuid });

      expect(result.success).toBe(true);
      expect(result.channelType).toBe(ChannelType.REST);
      expect(mockSendToRest).toHaveBeenCalledWith(uuid, expect.objectContaining({ chatId: uuid }));
    });

    it('should fail for REST when no sender configured', async () => {
      const routerNoRest = createRouter({ sendToRest: undefined });
      const uuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = await routerNoRest.route(uuid, { ...textMessage, chatId: uuid });

      expect(result.success).toBe(false);
      expect(result.channelType).toBe(ChannelType.REST);
      expect(result.error).toBe('REST channel sender not configured');
    });

    it('should fail for unknown chatId format', async () => {
      const result = await router.route('unknown-format', textMessage);

      expect(result.success).toBe(false);
      expect(result.channelType).toBe(ChannelType.UNKNOWN);
      expect(result.error).toContain('Unknown chatId format');
    });

    it('should handle sender errors', async () => {
      mockSendToFeishu.mockRejectedValueOnce(new Error('Feishu API error'));
      const result = await router.route('oc_test', textMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Feishu API error');
    });

    it('should use default CLI sender when not provided', async () => {
      const routerNoCli = new ChannelMessageRouter({
        sendToFeishu: mockSendToFeishu,
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await routerNoCli.route('cli-test', textMessage);

      expect(result.success).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('routeText', () => {
    it('should route text message correctly', async () => {
      const result = await router.routeText('oc_test', 'Hello', 'thread123');

      expect(result.success).toBe(true);
      expect(mockSendToFeishu).toHaveBeenCalledWith(
        'oc_test',
        expect.objectContaining({
          type: 'text',
          text: 'Hello',
          threadId: 'thread123',
        })
      );
    });
  });

  describe('routeCard', () => {
    it('should route card message correctly', async () => {
      const card = { config: {}, header: {}, elements: [] };
      const result = await router.routeCard('oc_test', card, 'thread123');

      expect(result.success).toBe(true);
      expect(mockSendToFeishu).toHaveBeenCalledWith(
        'oc_test',
        expect.objectContaining({
          type: 'card',
          card,
          threadId: 'thread123',
        })
      );
    });
  });

  describe('broadcast', () => {
    it('should broadcast to all registered channels', async () => {
      const mockChannel1: IChannel = {
        id: 'channel1',
        name: 'Test Channel 1',
        status: 'running',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
        onControl: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        isHealthy: vi.fn().mockReturnValue(true),
        getCapabilities: vi.fn().mockReturnValue({ supportsCard: true, supportsThread: true, supportsFile: true, supportsMarkdown: true, supportsMention: true, supportsUpdate: true }),
      };

      const mockChannel2: IChannel = {
        id: 'channel2',
        name: 'Test Channel 2',
        status: 'running',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
        onControl: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        isHealthy: vi.fn().mockReturnValue(true),
        getCapabilities: vi.fn().mockReturnValue({ supportsCard: true, supportsThread: true, supportsFile: true, supportsMarkdown: true, supportsMention: true, supportsUpdate: true }),
      };

      const channels = new Map<string, IChannel>();
      channels.set('channel1', mockChannel1);
      channels.set('channel2', mockChannel2);

      const routerWithChannels = createRouter({ channels });
      const message: OutgoingMessage = {
        chatId: 'oc_test',
        type: 'text',
        text: 'Broadcast message',
      };

      await routerWithChannels.broadcast(message);

      expect(mockChannel1.sendMessage).toHaveBeenCalledWith(message);
      expect(mockChannel2.sendMessage).toHaveBeenCalledWith(message);
    });

    it('should handle broadcast when no channels registered', async () => {
      const routerNoChannels = createRouter({ channels: undefined });
      const message: OutgoingMessage = {
        chatId: 'oc_test',
        type: 'text',
        text: 'Test',
      };

      // Should not throw
      await expect(routerNoChannels.broadcast(message)).resolves.toBeUndefined();
    });

    it('should continue broadcasting even if one channel fails', async () => {
      const mockChannel1: IChannel = {
        id: 'channel1',
        name: 'Test Channel 1',
        status: 'running',
        sendMessage: vi.fn().mockRejectedValue(new Error('Channel error')),
        onMessage: vi.fn(),
        onControl: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        isHealthy: vi.fn().mockReturnValue(true),
        getCapabilities: vi.fn().mockReturnValue({ supportsCard: true, supportsThread: true, supportsFile: true, supportsMarkdown: true, supportsMention: true, supportsUpdate: true }),
      };

      const mockChannel2: IChannel = {
        id: 'channel2',
        name: 'Test Channel 2',
        status: 'running',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
        onControl: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        isHealthy: vi.fn().mockReturnValue(true),
        getCapabilities: vi.fn().mockReturnValue({ supportsCard: true, supportsThread: true, supportsFile: true, supportsMarkdown: true, supportsMention: true, supportsUpdate: true }),
      };

      const channels = new Map<string, IChannel>();
      channels.set('channel1', mockChannel1);
      channels.set('channel2', mockChannel2);

      const routerWithChannels = createRouter({ channels });
      const message: OutgoingMessage = {
        chatId: 'oc_test',
        type: 'text',
        text: 'Broadcast message',
      };

      // Should not throw
      await routerWithChannels.broadcast(message);

      // Both channels should have been called
      expect(mockChannel1.sendMessage).toHaveBeenCalled();
      expect(mockChannel2.sendMessage).toHaveBeenCalled();
    });
  });

  describe('helper methods', () => {
    it('isFeishuChat should work correctly', () => {
      expect(router.isFeishuChat('oc_test')).toBe(true);
      expect(router.isFeishuChat('ou_test')).toBe(true);
      expect(router.isFeishuChat('cli-test')).toBe(false);
    });

    it('isCliChat should work correctly', () => {
      expect(router.isCliChat('cli-test')).toBe(true);
      expect(router.isCliChat('oc_test')).toBe(false);
    });

    it('isRestChat should work correctly', () => {
      expect(router.isRestChat('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(router.isRestChat('oc_test')).toBe(false);
    });

    it('getChannelTypeName should return human-readable name', () => {
      expect(router.getChannelTypeName('oc_test')).toBe('Feishu');
      expect(router.getChannelTypeName('cli-test')).toBe('Cli');
      expect(router.getChannelTypeName('123e4567-e89b-12d3-a456-426614174000')).toBe('Rest');
      expect(router.getChannelTypeName('unknown')).toBe('Unknown');
    });
  });
});

describe('Global router functions', () => {
  beforeEach(() => {
    resetChannelMessageRouter();
  });

  afterEach(() => {
    resetChannelMessageRouter();
  });

  it('initChannelMessageRouter should create global instance', () => {
    const mockSend = vi.fn();
    const router = initChannelMessageRouter({ sendToFeishu: mockSend });

    expect(router).toBeInstanceOf(ChannelMessageRouter);
    expect(getChannelMessageRouter()).toBe(router);
  });

  it('getChannelMessageRouter should throw if not initialized', () => {
    expect(() => getChannelMessageRouter()).toThrow('ChannelMessageRouter not initialized');
  });

  it('resetChannelMessageRouter should clear global instance', () => {
    const mockSend = vi.fn();
    initChannelMessageRouter({ sendToFeishu: mockSend });

    resetChannelMessageRouter();

    expect(() => getChannelMessageRouter()).toThrow('ChannelMessageRouter not initialized');
  });
});
