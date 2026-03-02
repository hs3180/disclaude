/**
 * Tests for ChannelMessageService.
 *
 * @see Issue #445 - Multi-channel MCP support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ChannelMessageService,
  getChannelMessageService,
  setChannelMessageService,
  resetChannelMessageService,
  detectChannelType,
} from './channel-message-service.js';
import type { IChannel } from '../channels/types.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

// Mock lark SDK
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      message: {
        create: vi.fn().mockResolvedValue({}),
        reply: vi.fn().mockResolvedValue({}),
      },
    },
  })),
  Domain: {
    Feishu: 'feishu',
  },
}));

describe('detectChannelType', () => {
  it('should detect CLI channel', () => {
    expect(detectChannelType('cli-abc123')).toBe('cli');
    expect(detectChannelType('cli-test-123')).toBe('cli');
    expect(detectChannelType('cli-')).toBe('cli');
  });

  it('should detect REST channel (UUID format)', () => {
    expect(detectChannelType('550e8400-e29b-41d4-a716-446655440000')).toBe('rest');
    expect(detectChannelType('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('rest');
    // Mixed case should also work
    expect(detectChannelType('550E8400-E29B-41D4-A716-446655440000')).toBe('rest');
  });

  it('should detect Feishu channel', () => {
    expect(detectChannelType('oc_abc123')).toBe('feishu');
    expect(detectChannelType('ou_xyz789')).toBe('feishu');
    expect(detectChannelType('oc_chat_id_here')).toBe('feishu');
  });

  it('should return unknown for unrecognized formats', () => {
    expect(detectChannelType('some-random-id')).toBe('unknown');
    expect(detectChannelType('12345')).toBe('unknown');
    expect(detectChannelType('')).toBe('unknown');
  });
});

describe('ChannelMessageService', () => {
  let service: ChannelMessageService;
  let mockChannel: IChannel;

  beforeEach(() => {
    service = new ChannelMessageService();

    // Create a mock channel
    mockChannel = {
      id: 'test-channel',
      name: 'Test Channel',
      status: 'running',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockReturnValue(true),
      onMessage: vi.fn(),
      onControl: vi.fn(),
    };
  });

  afterEach(() => {
    resetChannelMessageService();
  });

  describe('registerChannel', () => {
    it('should register a channel', () => {
      service.registerChannel(mockChannel);
      expect(service.getChannel('test-channel')).toBe(mockChannel);
    });

    it('should replace existing channel with same ID', () => {
      service.registerChannel(mockChannel);
      const newChannel = { ...mockChannel, name: 'New Channel' };
      service.registerChannel(newChannel);
      expect(service.getChannel('test-channel')).toBe(newChannel);
    });
  });

  describe('unregisterChannel', () => {
    it('should unregister a channel', () => {
      service.registerChannel(mockChannel);
      service.unregisterChannel('test-channel');
      expect(service.getChannel('test-channel')).toBeUndefined();
    });
  });

  describe('getChannels', () => {
    it('should return all registered channels', () => {
      const mockChannel2 = { ...mockChannel, id: 'test-channel-2' };
      service.registerChannel(mockChannel);
      service.registerChannel(mockChannel2);
      expect(service.getChannels()).toHaveLength(2);
    });
  });

  describe('sendText', () => {
    it('should handle CLI chatId', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await service.sendText('cli-test', 'Hello CLI');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Hello CLI'));
      consoleSpy.mockRestore();
    });

    it('should route to REST channel for UUID chatId', async () => {
      const restChannel = {
        ...mockChannel,
        id: 'rest',
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      service.registerChannel(restChannel);

      await service.sendText('550e8400-e29b-41d4-a716-446655440000', 'Hello REST');

      expect(restChannel.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '550e8400-e29b-41d4-a716-446655440000',
          type: 'text',
          text: 'Hello REST',
        })
      );
    });

    it('should call onMessageSent callback', async () => {
      const callback = vi.fn();
      const serviceWithCallback = new ChannelMessageService({
        onMessageSent: callback,
      });

      await serviceWithCallback.sendText('cli-test', 'Hello');

      expect(callback).toHaveBeenCalledWith('cli-test');
    });
  });

  describe('sendCard', () => {
    it('should handle CLI chatId with card description', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const card = { config: {}, header: { title: 'Test' }, elements: [] };
      await service.sendCard('cli-test', card, 'Card Description');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Card Description'));
      consoleSpy.mockRestore();
    });

    it('should route to REST channel for UUID chatId', async () => {
      const restChannel = {
        ...mockChannel,
        id: 'rest',
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      service.registerChannel(restChannel);

      const card = { config: {}, header: { title: 'Test' }, elements: [] };
      await service.sendCard('550e8400-e29b-41d4-a716-446655440000', card, 'Test Card');

      expect(restChannel.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '550e8400-e29b-41d4-a716-446655440000',
          type: 'card',
          card,
          description: 'Test Card',
        })
      );
    });
  });
});

describe('Global instance management', () => {
  afterEach(() => {
    resetChannelMessageService();
  });

  it('should create global instance on first call', () => {
    const instance = getChannelMessageService();
    expect(instance).toBeInstanceOf(ChannelMessageService);
  });

  it('should return same instance on subsequent calls', () => {
    const instance1 = getChannelMessageService();
    const instance2 = getChannelMessageService();
    expect(instance1).toBe(instance2);
  });

  it('should allow setting custom instance', () => {
    const customInstance = new ChannelMessageService();
    setChannelMessageService(customInstance);

    expect(getChannelMessageService()).toBe(customInstance);
  });

  it('should reset global instance', () => {
    getChannelMessageService();
    resetChannelMessageService();

    // After reset, should create new instance
    const instance = getChannelMessageService();
    expect(instance).toBeInstanceOf(ChannelMessageService);
  });
});
