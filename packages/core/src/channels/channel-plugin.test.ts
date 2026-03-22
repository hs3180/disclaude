/**
 * Tests for ChannelPlugin types and ChannelRegistry.
 * @see Issue #1422
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ChannelRegistry,
  type ChannelPlugin,
} from './channel-plugin.js';
import type { IChannel, ChannelConfig } from '../types/channel.js';

// --- Test Helpers ---

function createMockChannel(id: string): IChannel {
  return {
    id,
    name: id,
    status: 'running',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    isHealthy: () => true,
    getCapabilities: () => ({
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: false,
      supportsMention: false,
      supportsUpdate: false,
    }),
  };
}

function createMockPlugin(id: string, name: string): ChannelPlugin {
  return {
    id,
    name,
    version: '1.0.0',
    description: `Test plugin ${name}`,
    createChannel: (_config) => createMockChannel(id),
  };
}

// --- Tests ---

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  describe('register()', () => {
    it('should register a channel with factory', () => {
      const factory = (_config: ChannelConfig) => createMockChannel('test');
      registry.register('test', factory, 'builtin:test');

      expect(registry.has('test')).toBe(true);
      expect(registry.size()).toBe(1);
    });

    it('should register a channel as disabled', () => {
      const factory = (_config: ChannelConfig) => createMockChannel('test');
      registry.register('test', factory, 'builtin:test', undefined, false);

      const entry = registry.get('test');
      expect(entry).toBeDefined();
      expect(entry!.enabled).toBe(false);
    });

    it('should overwrite existing channel with warning', () => {
      const factory1 = (_config: ChannelConfig) => createMockChannel('test1');
      const factory2 = (_config: ChannelConfig) => createMockChannel('test2');

      registry.register('test', factory1, 'source1');
      registry.register('test', factory2, 'source2');

      const entry = registry.get('test')!;
      expect(entry.source).toBe('source2');
      expect(registry.size()).toBe(1);
    });
  });

  describe('registerPlugin()', () => {
    it('should register a ChannelPlugin', () => {
      const plugin = createMockPlugin('wechat', 'WeChat Channel');
      registry.registerPlugin(plugin);

      const entry = registry.get('wechat')!;
      expect(entry).toBeDefined();
      expect(entry.name).toBe('wechat');
      expect(entry.isDynamic).toBe(true);
      expect(entry.plugin).toBe(plugin);
      expect(entry.source).toContain('plugin:wechat');
    });

    it('should register plugin with enabled flag', () => {
      const plugin = createMockPlugin('custom', 'Custom');
      registry.registerPlugin(plugin, false);

      expect(registry.get('custom')!.enabled).toBe(false);
    });
  });

  describe('get()', () => {
    it('should return undefined for non-existent channel', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should return the registered channel', () => {
      const factory = () => createMockChannel('test');
      registry.register('test', factory, 'test-source');

      const entry = registry.get('test');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('test');
      expect(entry!.isDynamic).toBe(false);
      expect(entry!.source).toBe('test-source');
    });
  });

  describe('has()', () => {
    it('should return false for non-existent channel', () => {
      expect(registry.has('missing')).toBe(false);
    });

    it('should return true for registered channel', () => {
      registry.register('rest', () => createMockChannel('rest'), 'builtin');
      expect(registry.has('rest')).toBe(true);
    });
  });

  describe('getNames()', () => {
    it('should return empty array for empty registry', () => {
      expect(registry.getNames()).toEqual([]);
    });

    it('should return all registered names', () => {
      registry.register('rest', () => createMockChannel('rest'), 'builtin');
      registry.register('feishu', () => createMockChannel('feishu'), 'builtin');
      registry.registerPlugin(createMockPlugin('wechat', 'WeChat'));

      const names = registry.getNames();
      expect(names).toContain('rest');
      expect(names).toContain('feishu');
      expect(names).toContain('wechat');
      expect(names).toHaveLength(3);
    });
  });

  describe('getAll()', () => {
    it('should return all registered channels', () => {
      registry.register('a', () => createMockChannel('a'), 'builtin');
      registry.register('b', () => createMockChannel('b'), 'builtin');

      expect(registry.getAll()).toHaveLength(2);
    });
  });

  describe('getEnabled()', () => {
    it('should return only enabled channels', () => {
      registry.register('enabled', () => createMockChannel('enabled'), 'builtin', undefined, true);
      registry.register('disabled', () => createMockChannel('disabled'), 'builtin', undefined, false);

      const enabled = registry.getEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('enabled');
    });
  });

  describe('createChannel()', () => {
    it('should create a channel instance from registered factory', () => {
      const factory = () => createMockChannel('test-channel');
      registry.register('test', factory, 'builtin');

      const channel = registry.createChannel('test');
      expect(channel).toBeDefined();
      expect(channel.id).toBe('test-channel');
    });

    it('should pass config to factory', () => {
      let receivedConfig: ChannelConfig | undefined;
      registry.register('test', (config) => {
        receivedConfig = config;
        return createMockChannel('test');
      }, 'builtin');

      const config: ChannelConfig = { id: 'custom-id' };
      registry.createChannel('test', config);

      expect(receivedConfig).toEqual(config);
    });

    it('should throw error for non-existent channel', () => {
      expect(() => registry.createChannel('nonexistent')).toThrow(
        "Channel 'nonexistent' is not registered"
      );
    });

    it('should include available channels in error message', () => {
      registry.register('a', () => createMockChannel('a'), 'builtin');
      registry.register('b', () => createMockChannel('b'), 'builtin');

      expect(() => registry.createChannel('missing')).toThrow(/Available channels: a, b/);
    });
  });

  describe('unregister()', () => {
    it('should remove a registered channel', () => {
      registry.register('test', () => createMockChannel('test'), 'builtin');
      expect(registry.has('test')).toBe(true);

      const result = registry.unregister('test');
      expect(result).toBe(true);
      expect(registry.has('test')).toBe(false);
    });

    it('should return false for non-existent channel', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('should remove all registered channels', () => {
      registry.register('a', () => createMockChannel('a'), 'builtin');
      registry.register('b', () => createMockChannel('b'), 'builtin');

      registry.clear();
      expect(registry.size()).toBe(0);
    });
  });
});
