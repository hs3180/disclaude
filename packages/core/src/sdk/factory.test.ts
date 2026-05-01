/**
 * Tests for SDK Provider factory (Issue #1617 Phase 2/3)
 *
 * Tests the provider registry, caching, default management,
 * and availability checking logic in the factory module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentSDKProvider } from './interface.js';
import type { ProviderInfo } from './types.js';

// Mock functions defined at module scope (available for vi.doMock closures)
const mockSetupSkills = vi.fn().mockResolvedValue({ success: true });
const mockSetupAgents = vi.fn().mockResolvedValue({ success: true });
const mockCreateLogger = vi.fn().mockReturnValue({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
});

// Create a mock provider for testing
function createMockProvider(overrides: Partial<IAgentSDKProvider> = {}): IAgentSDKProvider {
  return {
    name: 'mock-provider',
    version: '1.0.0',
    getInfo: vi.fn().mockReturnValue({
      name: 'mock-provider',
      version: '1.0.0',
      available: true,
    }),
    validateConfig: vi.fn().mockReturnValue(true),
    dispose: vi.fn(),
    queryStream: vi.fn(),
    createInlineTool: vi.fn(),
    createMcpServer: vi.fn(),
    ...overrides,
  };
}

describe('Provider Factory', () => {
  let getProvider: typeof import('./factory.js').getProvider;
  let registerProvider: typeof import('./factory.js').registerProvider;
  let registerProviderClass: typeof import('./factory.js').registerProviderClass;
  let setDefaultProvider: typeof import('./factory.js').setDefaultProvider;
  let getDefaultProviderType: typeof import('./factory.js').getDefaultProviderType;
  let getAvailableProviders: typeof import('./factory.js').getAvailableProviders;
  let clearProviderCache: typeof import('./factory.js').clearProviderCache;
  let isProviderAvailable: typeof import('./factory.js').isProviderAvailable;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Use vi.doMock for dynamic mocking that works with vi.resetModules
    vi.doMock('../utils/skills-setup.js', () => ({
      setupSkillsInWorkspace: (...args: unknown[]) => mockSetupSkills(...args),
    }));
    vi.doMock('../utils/agents-setup.js', () => ({
      setupAgentsInWorkspace: (...args: unknown[]) => mockSetupAgents(...args),
    }));
    vi.doMock('../utils/logger.js', () => ({
      createLogger: (...args: unknown[]) => mockCreateLogger(...args),
    }));

    vi.resetModules();

    const mod = await import('./factory.js');
    ({
      getProvider,
      registerProvider,
      registerProviderClass,
      setDefaultProvider,
      getDefaultProviderType,
      getAvailableProviders,
      clearProviderCache,
      isProviderAvailable,
    } = mod);
  });

  describe('getProvider', () => {
    it('should return a provider for the default type (claude)', () => {
      const provider = getProvider();
      expect(provider).toBeDefined();
      expect(provider.name).toBe('disclaude');
    });

    it('should return the same cached instance on subsequent calls', () => {
      const provider1 = getProvider('claude');
      const provider2 = getProvider('claude');
      expect(provider1).toBe(provider2);
    });

    it('should throw for unknown provider type', () => {
      expect(() => getProvider('nonexistent')).toThrow(
        /Unknown provider type: nonexistent/,
      );
    });

    it('should include available types in error message', () => {
      expect(() => getProvider('nonexistent')).toThrow(/Available: claude/);
    });

    it('should trigger one-time skills setup on first call', () => {
      getProvider('claude');
      expect(mockSetupSkills).toHaveBeenCalledTimes(1);
    });

    it('should trigger one-time agents setup on first call', () => {
      getProvider('claude');
      expect(mockSetupAgents).toHaveBeenCalledTimes(1);
    });

    it('should not trigger setup again on subsequent calls', () => {
      getProvider('claude');
      getProvider('claude');
      expect(mockSetupSkills).toHaveBeenCalledTimes(1);
      expect(mockSetupAgents).toHaveBeenCalledTimes(1);
    });

    it('should return provider for a custom registered type', () => {
      const mockProvider = createMockProvider();
      registerProvider('custom', () => mockProvider);

      const provider = getProvider('custom');
      expect(provider).toBe(mockProvider);
    });

    it('should cache provider for custom registered type', () => {
      const factory = vi.fn().mockReturnValue(createMockProvider());
      registerProvider('custom', factory);

      getProvider('custom');
      getProvider('custom');
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerProvider', () => {
    it('should register a new provider factory', () => {
      const mockProvider = createMockProvider();
      registerProvider('test', () => mockProvider);

      const provider = getProvider('test');
      expect(provider).toBe(mockProvider);
    });

    it('should clear cache for the registered type', () => {
      const factory1 = vi.fn().mockReturnValue(createMockProvider());
      registerProvider('test', factory1);

      getProvider('test');
      expect(factory1).toHaveBeenCalledTimes(1);

      // Re-register with a new factory
      const factory2 = vi.fn().mockReturnValue(createMockProvider());
      registerProvider('test', factory2);

      getProvider('test');
      expect(factory2).toHaveBeenCalledTimes(1);
    });

    it('should allow overwriting an existing provider', () => {
      const mockProvider1 = createMockProvider({ name: 'provider-v1' });
      const mockProvider2 = createMockProvider({ name: 'provider-v2' });

      registerProvider('test', () => mockProvider1);
      expect(getProvider('test').name).toBe('provider-v1');

      registerProvider('test', () => mockProvider2);
      expect(getProvider('test').name).toBe('provider-v2');
    });
  });

  describe('registerProviderClass', () => {
    it('should register a provider constructor', () => {
      const mockProvider = createMockProvider();
      class TestProvider {
        constructor() {
          Object.assign(this, mockProvider);
        }
      }

      registerProviderClass('class-test', TestProvider as unknown as new () => IAgentSDKProvider);

      const provider = getProvider('class-test');
      expect(provider.name).toBe('mock-provider');
    });
  });

  describe('setDefaultProvider', () => {
    it('should set the default provider type', () => {
      registerProvider('new-default', () => createMockProvider());
      setDefaultProvider('new-default');

      expect(getDefaultProviderType()).toBe('new-default');
    });

    it('should throw for unknown provider type', () => {
      expect(() => setDefaultProvider('unknown')).toThrow(
        /Unknown provider type: unknown/,
      );
    });

    it('should affect getProvider when no type is specified', () => {
      const mockProvider = createMockProvider({ name: 'my-default' });
      registerProvider('my-default', () => mockProvider);
      setDefaultProvider('my-default');

      const provider = getProvider();
      expect(provider.name).toBe('my-default');
    });
  });

  describe('getDefaultProviderType', () => {
    it('should return "claude" by default', () => {
      expect(getDefaultProviderType()).toBe('claude');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return info for all registered providers', () => {
      const infos = getAvailableProviders();
      expect(infos.length).toBeGreaterThanOrEqual(1);

      const claudeInfo = infos.find((i: ProviderInfo) => i.name === 'disclaude');
      expect(claudeInfo).toBeDefined();
      expect(claudeInfo!.version).toBeDefined();
    });

    it('should return unavailable info when factory throws', () => {
      registerProvider('broken', () => {
        throw new Error('Factory error');
      });

      const infos = getAvailableProviders();
      const brokenInfo = infos.find((i: ProviderInfo) => i.name === 'broken');
      expect(brokenInfo).toBeDefined();
      expect(brokenInfo!.available).toBe(false);
      expect(brokenInfo!.unavailableReason).toBe('Failed to create provider instance');
    });

    it('should return version "unknown" for failed providers', () => {
      registerProvider('broken', () => {
        throw new Error('Factory error');
      });

      const infos = getAvailableProviders();
      const brokenInfo = infos.find((i: ProviderInfo) => i.name === 'broken');
      expect(brokenInfo!.version).toBe('unknown');
    });
  });

  describe('clearProviderCache', () => {
    it('should clear cache for a specific type', () => {
      const factory = vi.fn().mockReturnValue(createMockProvider());
      registerProvider('cached', factory);

      getProvider('cached');
      expect(factory).toHaveBeenCalledTimes(1);

      clearProviderCache('cached');

      getProvider('cached');
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('should clear all caches when no type specified', () => {
      const factory1 = vi.fn().mockReturnValue(createMockProvider());
      const factory2 = vi.fn().mockReturnValue(createMockProvider());
      registerProvider('a', factory1);
      registerProvider('b', factory2);

      getProvider('a');
      getProvider('b');
      expect(factory1).toHaveBeenCalledTimes(1);
      expect(factory2).toHaveBeenCalledTimes(1);

      clearProviderCache();

      getProvider('a');
      getProvider('b');
      expect(factory1).toHaveBeenCalledTimes(2);
      expect(factory2).toHaveBeenCalledTimes(2);
    });
  });

  describe('isProviderAvailable', () => {
    it('should return false for unregistered provider', () => {
      expect(isProviderAvailable('nonexistent')).toBe(false);
    });

    it('should return true when provider validateConfig returns true', () => {
      registerProvider('valid', () => createMockProvider({ validateConfig: () => true }));
      expect(isProviderAvailable('valid')).toBe(true);
    });

    it('should return false when provider validateConfig returns false', () => {
      registerProvider('invalid', () => createMockProvider({ validateConfig: () => false }));
      expect(isProviderAvailable('invalid')).toBe(false);
    });

    it('should return false when factory throws', () => {
      registerProvider('throws', () => {
        throw new Error('Cannot create');
      });
      expect(isProviderAvailable('throws')).toBe(false);
    });
  });
});
