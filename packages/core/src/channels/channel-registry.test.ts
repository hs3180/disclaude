/**
 * Tests for Channel Registry.
 *
 * @module channels/channel-registry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChannelRegistry,
  ChannelRegistryError,
} from './channel-registry.js';
import type { ChannelDescriptor, IChannel, ChannelConfig } from '../types/channel.js';

/**
 * Create a mock channel descriptor for testing.
 */
function createMockDescriptor(overrides?: Partial<ChannelDescriptor>): ChannelDescriptor {
  const counter = createMockDescriptor.counter++;
  return {
    type: `mock-channel-${counter}`,
    name: `Mock Channel ${counter}`,
    factory: (_config: ChannelConfig): IChannel => ({
      id: `mock-${counter}`,
      name: `Mock Channel ${counter}`,
      status: 'stopped',
      onMessage: () => {},
      onControl: () => {},
      sendMessage: async () => undefined,
      start: async () => {},
      stop: async () => {},
      isHealthy: () => true,
      getCapabilities: () => ({
        supportsCard: false,
        supportsThread: false,
        supportsFile: false,
        supportsMarkdown: true,
        supportsMention: false,
        supportsUpdate: false,
        supportedMcpTools: [],
      }),
    }),
    defaultCapabilities: {
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
      supportedMcpTools: [],
    },
    ...overrides,
  };
}
createMockDescriptor.counter = 1;

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
    createMockDescriptor.counter = 1;
  });

  describe('register()', () => {
    it('should register a channel descriptor', () => {
      const descriptor = createMockDescriptor({ type: 'test' });
      registry.register(descriptor);

      expect(registry.has('test')).toBe(true);
    });

    it('should throw ChannelRegistryError on duplicate registration', () => {
      const descriptor = createMockDescriptor({ type: 'test' });
      registry.register(descriptor);

      expect(() => registry.register(descriptor)).toThrow(ChannelRegistryError);
      expect(() => registry.register(descriptor)).toThrow(
        'Channel type "test" is already registered'
      );
    });

    it('should throw ChannelRegistryError with same type but different descriptor', () => {
      const desc1 = createMockDescriptor({ type: 'test', name: 'First' });
      const desc2 = createMockDescriptor({ type: 'test', name: 'Second' });
      registry.register(desc1);

      expect(() => registry.register(desc2)).toThrow(ChannelRegistryError);
    });

    it('should register multiple different descriptors', () => {
      const desc1 = createMockDescriptor({ type: 'channel-a' });
      const desc2 = createMockDescriptor({ type: 'channel-b' });
      const desc3 = createMockDescriptor({ type: 'channel-c' });

      registry.register(desc1);
      registry.register(desc2);
      registry.register(desc3);

      expect(registry.getAll()).toHaveLength(3);
    });
  });

  describe('get()', () => {
    it('should return the registered descriptor', () => {
      const descriptor = createMockDescriptor({ type: 'test' });
      registry.register(descriptor);

      const result = registry.get('test');
      expect(result).toBe(descriptor);
      expect(result?.type).toBe('test');
    });

    it('should return undefined for unknown type', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    it('should return empty array when nothing is registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('should return all registered descriptors', () => {
      const desc1 = createMockDescriptor({ type: 'a' });
      const desc2 = createMockDescriptor({ type: 'b' });

      registry.register(desc1);
      registry.register(desc2);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(d => d.type).sort()).toEqual(['a', 'b']);
    });
  });

  describe('has()', () => {
    it('should return true for registered type', () => {
      registry.register(createMockDescriptor({ type: 'test' }));
      expect(registry.has('test')).toBe(true);
    });

    it('should return false for unregistered type', () => {
      expect(registry.has('test')).toBe(false);
    });

    it('should be case-sensitive', () => {
      registry.register(createMockDescriptor({ type: 'Test' }));
      expect(registry.has('Test')).toBe(true);
      expect(registry.has('test')).toBe(false);
    });
  });

  describe('create()', () => {
    it('should create a channel instance using the registered factory', () => {
      let factoryCalled = false;
      const descriptor = createMockDescriptor({
        type: 'test',
        factory: (config) => {
          factoryCalled = true;
          return {
            id: config.id || 'test',
            name: 'Test Channel',
            status: 'stopped',
            onMessage: () => {},
            onControl: () => {},
            sendMessage: async () => undefined,
            start: async () => {},
            stop: async () => {},
            isHealthy: () => true,
            getCapabilities: () => ({
              supportsCard: false,
              supportsThread: false,
              supportsFile: false,
              supportsMarkdown: true,
              supportsMention: false,
              supportsUpdate: false,
              supportedMcpTools: [],
            }),
          };
        },
      });

      registry.register(descriptor);
      const channel = registry.create('test', { id: 'custom-id' });

      expect(factoryCalled).toBe(true);
      expect(channel.id).toBe('custom-id');
    });

    it('should create channel with default config when no config provided', () => {
      registry.register(createMockDescriptor({ type: 'test' }));
      const channel = registry.create('test');

      expect(channel).toBeDefined();
      expect(typeof channel.start).toBe('function');
    });

    it('should throw ChannelRegistryError for unknown type', () => {
      expect(() => registry.create('unknown')).toThrow(ChannelRegistryError);
      expect(() => registry.create('unknown')).toThrow(
        'Unknown channel type "unknown"'
      );
    });

    it('should list available types in error message', () => {
      registry.register(createMockDescriptor({ type: 'alpha' }));
      registry.register(createMockDescriptor({ type: 'beta' }));

      try {
        registry.create('unknown');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect((error as ChannelRegistryError).message).toContain('alpha');
        expect((error as ChannelRegistryError).message).toContain('beta');
      }
    });
  });

  describe('getCapabilities()', () => {
    it('should return default capabilities for registered type', () => {
      const capabilities = {
        supportsCard: true,
        supportsThread: true,
        supportsFile: true,
        supportsMarkdown: true,
        supportsMention: false,
        supportsUpdate: false,
        supportedMcpTools: ['send_text', 'send_card'],
      };

      registry.register(createMockDescriptor({
        type: 'test',
        defaultCapabilities: capabilities,
      }));

      expect(registry.getCapabilities('test')).toEqual(capabilities);
    });

    it('should throw ChannelRegistryError for unknown type', () => {
      expect(() => registry.getCapabilities('unknown')).toThrow(ChannelRegistryError);
    });

    it('should list available types in error message', () => {
      registry.register(createMockDescriptor({ type: 'feishu' }));

      try {
        registry.getCapabilities('unknown');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect((error as ChannelRegistryError).message).toContain('feishu');
      }
    });
  });

  describe('unregister()', () => {
    it('should remove a registered descriptor', () => {
      registry.register(createMockDescriptor({ type: 'test' }));
      expect(registry.has('test')).toBe(true);

      const result = registry.unregister('test');
      expect(result).toBe(true);
      expect(registry.has('test')).toBe(false);
    });

    it('should return false for unknown type', () => {
      expect(registry.unregister('unknown')).toBe(false);
    });

    it('should allow re-registration after unregister', () => {
      const desc1 = createMockDescriptor({ type: 'test', name: 'First' });
      const desc2 = createMockDescriptor({ type: 'test', name: 'Second' });

      registry.register(desc1);
      registry.unregister('test');
      // Should not throw - type was unregistered
      registry.register(desc2);

      expect(registry.get('test')?.name).toBe('Second');
    });
  });

  describe('ChannelRegistryError', () => {
    it('should have correct name property', () => {
      const error = new ChannelRegistryError('test message');
      expect(error.name).toBe('ChannelRegistryError');
      expect(error.message).toBe('test message');
      expect(error).toBeInstanceOf(Error);
    });
  });
});
