/**
 * Tests for Chat Channel Registry.
 *
 * @see Issue #445
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatChannelRegistry } from './chat-channel-registry.js';

describe('ChatChannelRegistry', () => {
  let registry: ChatChannelRegistry;

  beforeEach(() => {
    ChatChannelRegistry.resetInstance();
    registry = ChatChannelRegistry.getInstance();
  });

  afterEach(() => {
    registry.clear();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const instance1 = ChatChannelRegistry.getInstance();
      const instance2 = ChatChannelRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should reset to a new instance', () => {
      const instance1 = ChatChannelRegistry.getInstance();
      instance1.register('cli-test', 'feishu'); // Override cli- prefix

      ChatChannelRegistry.resetInstance();
      const instance2 = ChatChannelRegistry.getInstance();

      // After reset, cli-test should be detected as cli (not overridden)
      expect(instance2.lookup('cli-test')).toBe('cli');
    });
  });

  describe('register and lookup', () => {
    it('should register a chat with channel type', () => {
      registry.register('chat-123', 'feishu');
      expect(registry.lookup('chat-123')).toBe('feishu');
    });

    it('should update channel type for existing chat', () => {
      registry.register('chat-123', 'feishu');
      registry.register('chat-123', 'cli');
      expect(registry.lookup('chat-123')).toBe('cli');
    });

    it('should store extra metadata', () => {
      registry.register('chat-123', 'feishu', { channelId: 'feishu-1' });
      const metadata = registry.getMetadata('chat-123');
      expect(metadata?.extra?.channelId).toBe('feishu-1');
    });
  });

  describe('detectChannelType', () => {
    it('should detect CLI channel from cli- prefix', () => {
      expect(registry.detectChannelType('cli-test')).toBe('cli');
      expect(registry.detectChannelType('cli-12345')).toBe('cli');
    });

    it('should detect REST channel from rest- prefix', () => {
      expect(registry.detectChannelType('rest-test')).toBe('rest');
      expect(registry.detectChannelType('rest-12345')).toBe('rest');
    });

    it('should detect REST channel from UUID format', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(registry.detectChannelType(uuid)).toBe('rest');
    });

    it('should detect Feishu channel from oc_ prefix', () => {
      expect(registry.detectChannelType('oc_1234567890abcdef')).toBe('feishu');
    });

    it('should detect Feishu channel from ou_ prefix', () => {
      expect(registry.detectChannelType('ou_1234567890abcdef')).toBe('feishu');
    });

    it('should default to feishu for unknown format', () => {
      // For backward compatibility
      expect(registry.detectChannelType('unknown-format')).toBe('feishu');
    });
  });

  describe('lookup with auto-detection', () => {
    it('should return registered type over detected type', () => {
      // UUID would normally be detected as REST
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      registry.register(uuid, 'feishu');
      expect(registry.lookup(uuid)).toBe('feishu');
    });

    it('should auto-detect when not registered', () => {
      expect(registry.lookup('cli-test')).toBe('cli');
    });
  });

  describe('unregister', () => {
    it('should remove a chat registration', () => {
      registry.register('chat-123', 'feishu');
      registry.unregister('chat-123');
      // After unregister, should fall back to detection
      expect(registry.lookup('chat-123')).toBe('feishu'); // default
    });
  });

  describe('getChatsByType', () => {
    it('should return chats of a specific type', () => {
      registry.register('chat-1', 'feishu');
      registry.register('chat-2', 'feishu');
      registry.register('chat-3', 'cli');

      const feishuChats = registry.getChatsByType('feishu');
      expect(feishuChats).toContain('chat-1');
      expect(feishuChats).toContain('chat-2');
      expect(feishuChats).not.toContain('chat-3');
    });
  });

  describe('getStats', () => {
    it('should return statistics', () => {
      registry.register('chat-1', 'feishu');
      registry.register('chat-2', 'cli');
      registry.register('chat-3', 'rest');

      const stats = registry.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byType.feishu).toBe(1);
      expect(stats.byType.cli).toBe(1);
      expect(stats.byType.rest).toBe(1);
    });
  });

  describe('isChannelType', () => {
    it('should check if chat belongs to channel type', () => {
      registry.register('chat-123', 'feishu');
      expect(registry.isChannelType('chat-123', 'feishu')).toBe(true);
      expect(registry.isChannelType('chat-123', 'cli')).toBe(false);
    });
  });
});
