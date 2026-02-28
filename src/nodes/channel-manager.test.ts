/**
 * Tests for ChannelManager.
 *
 * Issue #241: Extracted from CommunicationNode for better separation of concerns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelManager } from './channel-manager.js';
import type { IChannel, OutgoingMessage, IncomingMessage, ControlResponse } from '../channels/types.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Helper to create mock channel
function createMockChannel(id: string, name: string = `Channel ${id}`): IChannel {
  return {
    id,
    name,
    status: 'stopped',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

describe('ChannelManager', () => {
  let manager: ChannelManager;

  beforeEach(() => {
    manager = new ChannelManager();
  });

  describe('register()', () => {
    it('should register a new channel', () => {
      const channel = createMockChannel('feishu');
      manager.register(channel);

      expect(manager.has('feishu')).toBe(true);
      expect(manager.size()).toBe(1);
    });

    it('should replace existing channel with same ID', () => {
      const channel1 = createMockChannel('feishu', 'Feishu 1');
      const channel2 = createMockChannel('feishu', 'Feishu 2');

      manager.register(channel1);
      manager.register(channel2);

      expect(manager.size()).toBe(1);
      expect(manager.get('feishu')?.name).toBe('Feishu 2');
    });
  });

  describe('get()', () => {
    it('should return channel by ID', () => {
      const channel = createMockChannel('feishu');
      manager.register(channel);

      expect(manager.get('feishu')).toBe(channel);
    });

    it('should return undefined for non-existent channel', () => {
      expect(manager.get('non-existent')).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    it('should return all registered channels', () => {
      const channel1 = createMockChannel('feishu');
      const channel2 = createMockChannel('rest');

      manager.register(channel1);
      manager.register(channel2);

      const all = manager.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(c => c.id)).toContain('feishu');
      expect(all.map(c => c.id)).toContain('rest');
    });

    it('should return empty array if no channels', () => {
      expect(manager.getAll()).toEqual([]);
    });
  });

  describe('broadcast()', () => {
    it('should send message to all channels', async () => {
      const channel1 = createMockChannel('feishu');
      const channel2 = createMockChannel('rest');

      manager.register(channel1);
      manager.register(channel2);

      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      await manager.broadcast(message);

      expect(channel1.sendMessage).toHaveBeenCalledWith(message);
      expect(channel2.sendMessage).toHaveBeenCalledWith(message);
    });

    it('should not fail if one channel throws error', async () => {
      const channel1 = createMockChannel('feishu');
      const channel2 = createMockChannel('rest');
      (channel1.sendMessage as any).mockRejectedValue(new Error('Send failed'));

      manager.register(channel1);
      manager.register(channel2);

      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      // Should not throw
      await expect(manager.broadcast(message)).resolves.toBeUndefined();

      // Other channel should still be called
      expect(channel2.sendMessage).toHaveBeenCalledWith(message);
    });

    it('should warn if no channels registered', async () => {
      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      // Should not throw
      await expect(manager.broadcast(message)).resolves.toBeUndefined();
    });
  });

  describe('startAll()', () => {
    it('should start all channels', async () => {
      const channel1 = createMockChannel('feishu');
      const channel2 = createMockChannel('rest');

      manager.register(channel1);
      manager.register(channel2);

      await manager.startAll();

      expect(channel1.start).toHaveBeenCalled();
      expect(channel2.start).toHaveBeenCalled();
    });

    it('should throw if channel fails to start', async () => {
      const channel1 = createMockChannel('feishu');
      (channel1.start as any).mockRejectedValue(new Error('Start failed'));

      manager.register(channel1);

      await expect(manager.startAll()).rejects.toThrow('Start failed');
    });
  });

  describe('stopAll()', () => {
    it('should stop all channels', async () => {
      const channel1 = createMockChannel('feishu');
      const channel2 = createMockChannel('rest');

      manager.register(channel1);
      manager.register(channel2);

      await manager.stopAll();

      expect(channel1.stop).toHaveBeenCalled();
      expect(channel2.stop).toHaveBeenCalled();
    });

    it('should continue stopping other channels if one fails', async () => {
      const channel1 = createMockChannel('feishu');
      const channel2 = createMockChannel('rest');
      (channel1.stop as any).mockRejectedValue(new Error('Stop failed'));

      manager.register(channel1);
      manager.register(channel2);

      // Should not throw
      await expect(manager.stopAll()).resolves.toBeUndefined();

      // Other channel should still be stopped
      expect(channel2.stop).toHaveBeenCalled();
    });
  });

  describe('setupHandlers()', () => {
    it('should set up message and control handlers', () => {
      const channel = createMockChannel('feishu');
      manager.register(channel);

      const messageHandler = vi.fn().mockResolvedValue(undefined);
      const controlHandler = vi.fn().mockResolvedValue({ success: true } as ControlResponse);

      manager.setupHandlers(channel, messageHandler, controlHandler);

      expect(channel.onMessage).toHaveBeenCalled();
      expect(channel.onControl).toHaveBeenCalledWith(controlHandler);
    });

    it('should handle message handler errors gracefully', () => {
      const channel = createMockChannel('feishu');
      manager.register(channel);

      const messageHandler = vi.fn().mockRejectedValue(new Error('Handler error'));
      const controlHandler = vi.fn().mockResolvedValue({ success: true } as ControlResponse);

      manager.setupHandlers(channel, messageHandler, controlHandler);

      // Get the handler that was passed to onMessage
      const [[registeredHandler]] = (channel.onMessage as any).mock.calls;

      // Call the handler with a message - should not throw
      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
      };

      // The wrapper should catch the error internally
      void expect(registeredHandler(message)).resolves.toBeUndefined();
    });
  });

  describe('getStatusInfo()', () => {
    it('should return status info for all channels', () => {
      const channel1 = createMockChannel('feishu');
      (channel1 as any).status = 'running';
      const channel2 = createMockChannel('rest');
      (channel2 as any).status = 'stopped';

      manager.register(channel1);
      manager.register(channel2);

      const statusInfo = manager.getStatusInfo();

      expect(statusInfo).toHaveLength(2);
      expect(statusInfo.find(s => s.id === 'feishu')?.status).toBe('running');
      expect(statusInfo.find(s => s.id === 'rest')?.status).toBe('stopped');
    });
  });

  describe('clear()', () => {
    it('should clear all channels', () => {
      const channel = createMockChannel('feishu');
      manager.register(channel);

      expect(manager.size()).toBe(1);

      manager.clear();

      expect(manager.size()).toBe(0);
    });
  });
});
