/**
 * Tests for Channel Plugin system (Issue #1422).
 *
 * Tests ChannelRegistry, type guards, and plugin registration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChannelRegistry,
  isChannelPlugin,
  isChannelFactory,
  type ChannelPlugin,
  type ChannelFactory,
} from './channel-plugin.js';
import type { IChannel, ChannelStatus, ChannelCapabilities, OutgoingMessage, MessageHandler, ControlHandler } from '../types/channel.js';

// Mock channel for testing
function createMockChannel(id: string, name: string): IChannel {
  let status: ChannelStatus = 'stopped';
  return {
    id,
    name,
    get status() { return status; },
    onMessage: (_handler: MessageHandler) => {},
    onControl: (_handler: ControlHandler) => {},
    sendMessage: async (_message: OutgoingMessage) => {},
    start: async () => { status = 'running'; },
    stop: async () => { status = 'stopped'; },
    isHealthy: () => status === 'running',
    getCapabilities: (): ChannelCapabilities => ({
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
    }),
  };
}

describe('isChannelPlugin', () => {
  it('should return true for valid ChannelPlugin objects', () => {
    const plugin: ChannelPlugin = {
      id: 'test',
      name: 'Test Channel',
      version: '1.0.0',
      createChannel: () => createMockChannel('test', 'Test'),
    };
    expect(isChannelPlugin(plugin)).toBe(true);
  });

  it('should return false for objects without id', () => {
    expect(isChannelPlugin({ name: 'test', createChannel: () => {} })).toBe(false);
  });

  it('should return false for objects without createChannel', () => {
    expect(isChannelPlugin({ id: 'test', name: 'test' })).toBe(false);
  });

  it('should return false for non-objects', () => {
    expect(isChannelPlugin(null)).toBe(false);
    expect(isChannelPlugin('string')).toBe(false);
    expect(isChannelPlugin(42)).toBe(false);
    expect(isChannelPlugin(undefined)).toBe(false);
  });
});

describe('isChannelFactory', () => {
  it('should return true for functions', () => {
    const factory: ChannelFactory = () => createMockChannel('test', 'Test');
    expect(isChannelFactory(factory)).toBe(true);
  });

  it('should return false for non-functions', () => {
    expect(isChannelFactory(null)).toBe(false);
    expect(isChannelFactory('string')).toBe(false);
    expect(isChannelFactory({})).toBe(false);
  });
});

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  describe('registerBuiltin', () => {
    it('should register a builtin channel', () => {
      registry.registerBuiltin('rest', 'REST API', () => createMockChannel('rest', 'REST'));
      expect(registry.has('rest')).toBe(true);
    });

    it('should store source as builtin', () => {
      registry.registerBuiltin('rest', 'REST API', () => createMockChannel('rest', 'REST'));
      const entries = registry.getBuiltin();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('builtin');
    });
  });

  describe('registerPlugin', () => {
    it('should register a ChannelPlugin', () => {
      const plugin: ChannelPlugin = {
        id: 'wechat',
        name: 'WeChat',
        version: '1.0.0',
        createChannel: () => createMockChannel('wechat', 'WeChat'),
      };
      registry.registerPlugin(plugin);
      expect(registry.has('wechat')).toBe(true);
    });

    it('should store source as dynamic', () => {
      const plugin: ChannelPlugin = {
        id: 'wechat',
        name: 'WeChat',
        version: '1.0.0',
        createChannel: () => createMockChannel('wechat', 'WeChat'),
      };
      registry.registerPlugin(plugin);
      const entries = registry.getDynamic();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('dynamic');
    });
  });

  describe('registerDynamic', () => {
    it('should register a dynamic channel with module path', () => {
      registry.registerDynamic(
        'custom',
        'Custom Channel',
        './channels/custom',
        () => createMockChannel('custom', 'Custom')
      );
      expect(registry.has('custom')).toBe(true);
      const entry = registry.getAll()[0];
      expect(entry.modulePath).toBe('./channels/custom');
    });
  });

  describe('getFactory', () => {
    it('should return factory for registered channel', () => {
      const factory = () => createMockChannel('rest', 'REST');
      registry.registerBuiltin('rest', 'REST', factory);
      expect(registry.getFactory('rest')).toBe(factory);
    });

    it('should return undefined for unknown channel', () => {
      expect(registry.getFactory('unknown')).toBeUndefined();
    });
  });

  describe('createChannel', () => {
    it('should create a channel instance', () => {
      registry.registerBuiltin('rest', 'REST', (_config) => createMockChannel('rest', 'REST'));
      const channel = registry.createChannel('rest', {});
      expect(channel.id).toBe('rest');
      expect(channel.name).toBe('REST');
    });

    it('should throw for unknown channel', () => {
      expect(() => registry.createChannel('unknown', {})).toThrow("Channel 'unknown' not found");
    });
  });

  describe('remove', () => {
    it('should remove a registered channel', () => {
      registry.registerBuiltin('rest', 'REST', () => createMockChannel('rest', 'REST'));
      expect(registry.remove('rest')).toBe(true);
      expect(registry.has('rest')).toBe(false);
    });

    it('should return false for unknown channel', () => {
      expect(registry.remove('unknown')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all entries', () => {
      registry.registerBuiltin('rest', 'REST', () => createMockChannel('rest', 'REST'));
      registry.registerBuiltin('feishu', 'Feishu', () => createMockChannel('feishu', 'Feishu'));
      registry.clear();
      expect(registry.size).toBe(0);
    });
  });

  describe('getIds', () => {
    it('should return all registered channel IDs', () => {
      registry.registerBuiltin('rest', 'REST', () => createMockChannel('rest', 'REST'));
      registry.registerBuiltin('feishu', 'Feishu', () => createMockChannel('feishu', 'Feishu'));
      expect(registry.getIds()).toEqual(['rest', 'feishu']);
    });
  });

  describe('getAll', () => {
    it('should return all entries', () => {
      registry.registerBuiltin('rest', 'REST', () => createMockChannel('rest', 'REST'));
      registry.registerPlugin({
        id: 'wechat',
        name: 'WeChat',
        version: '1.0.0',
        createChannel: () => createMockChannel('wechat', 'WeChat'),
      });
      expect(registry.getAll()).toHaveLength(2);
    });
  });

  describe('getBuiltin / getDynamic', () => {
    it('should separate builtin and dynamic entries', () => {
      registry.registerBuiltin('rest', 'REST', () => createMockChannel('rest', 'REST'));
      registry.registerPlugin({
        id: 'wechat',
        name: 'WeChat',
        version: '1.0.0',
        createChannel: () => createMockChannel('wechat', 'WeChat'),
      });
      expect(registry.getBuiltin()).toHaveLength(1);
      expect(registry.getDynamic()).toHaveLength(1);
    });
  });

  describe('size', () => {
    it('should return correct count', () => {
      expect(registry.size).toBe(0);
      registry.registerBuiltin('rest', 'REST', () => createMockChannel('rest', 'REST'));
      expect(registry.size).toBe(1);
      registry.registerBuiltin('feishu', 'Feishu', () => createMockChannel('feishu', 'Feishu'));
      expect(registry.size).toBe(2);
    });
  });
});
