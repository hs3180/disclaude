/**
 * Tests for Channel Registry.
 *
 * Tests the ChannelRegistry class which manages channel type descriptors
 * and provides factory-based channel instantiation.
 *
 * @module channels/channel-registry.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelRegistry, ChannelRegistryError } from './channel-registry.js';
import type { ChannelDescriptor, ChannelConfig, IChannel, ChannelCapabilities } from '../types/channel.js';

// Helper: create a mock channel
function createMockChannel(config: ChannelConfig): IChannel {
  return {
    id: (config as { id?: string }).id || 'mock',
    name: 'MockChannel',
    status: 'stopped',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    isHealthy: () => true,
    getCapabilities: () => ({ supportsCard: false, supportsThread: false, supportsFile: false, supportsMarkdown: true, supportsMention: false, supportsUpdate: false }),
  };
}

// Helper: create a test descriptor
function createTestDescriptor(overrides?: Partial<ChannelDescriptor>): ChannelDescriptor {
  return {
    type: overrides?.type || 'test',
    name: overrides?.name || 'Test Channel',
    factory: overrides?.factory || createMockChannel,
    defaultCapabilities: overrides?.defaultCapabilities || {
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
    },
  };
}

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  describe('constructor', () => {
    it('should create an empty registry', () => {
      expect(registry.size).toBe(0);
      expect(registry.getAll()).toEqual([]);
      expect(registry.getTypes()).toEqual([]);
    });
  });

  describe('register', () => {
    it('should register a channel descriptor', () => {
      const descriptor = createTestDescriptor();
      registry.register(descriptor);

      expect(registry.size).toBe(1);
      expect(registry.has('test')).toBe(true);
    });

    it('should store the descriptor correctly', () => {
      const descriptor = createTestDescriptor();
      registry.register(descriptor);

      const retrieved = registry.get('test');
      expect(retrieved).toBe(descriptor);
      expect(retrieved!.type).toBe('test');
      expect(retrieved!.name).toBe('Test Channel');
    });

    it('should register multiple descriptors', () => {
      registry.register(createTestDescriptor({ type: 'rest', name: 'REST' }));
      registry.register(createTestDescriptor({ type: 'feishu', name: 'Feishu' }));
      registry.register(createTestDescriptor({ type: 'wechat', name: 'WeChat' }));

      expect(registry.size).toBe(3);
      expect(registry.getTypes()).toEqual(['rest', 'feishu', 'wechat']);
    });

    it('should throw on duplicate registration', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));

      expect(() => {
        registry.register(createTestDescriptor({ type: 'rest' }));
      }).toThrow(ChannelRegistryError);
    });

    it('should throw with descriptive error message on duplicate', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));

      try {
        registry.register(createTestDescriptor({ type: 'rest' }));
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect((error as Error).message).toContain('rest');
        expect((error as Error).message).toContain('already registered');
      }
    });

    it('should allow different types with same name', () => {
      registry.register(createTestDescriptor({ type: 'channel-a', name: 'Same Name' }));
      registry.register(createTestDescriptor({ type: 'channel-b', name: 'Same Name' }));

      expect(registry.size).toBe(2);
    });
  });

  describe('unregister', () => {
    it('should unregister a registered descriptor', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));
      expect(registry.has('rest')).toBe(true);

      const result = registry.unregister('rest');
      expect(result).toBe(true);
      expect(registry.has('rest')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('should return false for non-existent type', () => {
      const result = registry.unregister('nonexistent');
      expect(result).toBe(false);
    });

    it('should allow re-registration after unregister', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));
      registry.unregister('rest');

      // Should not throw
      registry.register(createTestDescriptor({ type: 'rest' }));
      expect(registry.has('rest')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return descriptor for registered type', () => {
      const descriptor = createTestDescriptor({ type: 'feishu' });
      registry.register(descriptor);

      const result = registry.get('feishu');
      expect(result).toBe(descriptor);
    });

    it('should return undefined for non-registered type', () => {
      const result = registry.get('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for registered type', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));
      expect(registry.has('rest')).toBe(true);
    });

    it('should return false for non-registered type', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('should return false for empty registry', () => {
      expect(registry.has('anything')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return empty array for empty registry', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('should return all registered descriptors', () => {
      const rest = createTestDescriptor({ type: 'rest', name: 'REST' });
      const feishu = createTestDescriptor({ type: 'feishu', name: 'Feishu' });
      registry.register(rest);
      registry.register(feishu);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(rest);
      expect(all).toContain(feishu);
    });
  });

  describe('getTypes', () => {
    it('should return empty array for empty registry', () => {
      expect(registry.getTypes()).toEqual([]);
    });

    it('should return all registered type identifiers', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));
      registry.register(createTestDescriptor({ type: 'feishu' }));

      const types = registry.getTypes();
      expect(types).toHaveLength(2);
      expect(types).toContain('rest');
      expect(types).toContain('feishu');
    });
  });

  describe('create', () => {
    it('should create a channel using the registered factory', () => {
      const mockChannel = createMockChannel({ id: 'test-channel' });
      const factory = vi.fn().mockReturnValue(mockChannel);

      registry.register(createTestDescriptor({ type: 'rest', factory }));

      const channel = registry.create('rest', { id: 'test-channel' });

      expect(channel).toBe(mockChannel);
      expect(factory).toHaveBeenCalledWith({ id: 'test-channel' });
    });

    it('should throw ChannelRegistryError for unregistered type', () => {
      expect(() => {
        registry.create('nonexistent', {});
      }).toThrow(ChannelRegistryError);
    });

    it('should include available types in error message', () => {
      registry.register(createTestDescriptor({ type: 'rest' }));
      registry.register(createTestDescriptor({ type: 'feishu' }));

      try {
        registry.create('nonexistent', {});
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelRegistryError);
        const msg = (error as Error).message;
        expect(msg).toContain('rest');
        expect(msg).toContain('feishu');
        expect(msg).toContain('not registered');
      }
    });

    it('should pass config through to factory', () => {
      const factory = vi.fn().mockReturnValue(createMockChannel({}));
      registry.register(createTestDescriptor({ type: 'rest', factory }));

      const config = { id: 'my-rest', enabled: true };
      registry.create('rest', config);

      expect(factory).toHaveBeenCalledWith(config);
    });
  });

  describe('size', () => {
    it('should reflect number of registered descriptors', () => {
      expect(registry.size).toBe(0);

      registry.register(createTestDescriptor({ type: 'a' }));
      expect(registry.size).toBe(1);

      registry.register(createTestDescriptor({ type: 'b' }));
      expect(registry.size).toBe(2);

      registry.unregister('a');
      expect(registry.size).toBe(1);
    });
  });

  describe('ChannelDescriptor interface', () => {
    it('should accept descriptors with default capabilities', () => {
      const capabilities: ChannelCapabilities = {
        supportsCard: true,
        supportsThread: true,
        supportsFile: true,
        supportsMarkdown: true,
        supportsMention: true,
        supportsUpdate: true,
        supportedMcpTools: ['send_text', 'send_card'],
      };

      const descriptor: ChannelDescriptor = {
        type: 'test',
        name: 'Test',
        factory: createMockChannel,
        defaultCapabilities: capabilities,
      };

      registry.register(descriptor);
      expect(registry.get('test')!.defaultCapabilities.supportedMcpTools).toEqual([
        'send_text',
        'send_card',
      ]);
    });
  });
});
