/**
 * Tests for SDK provider factory (packages/core/src/sdk/factory.ts)
 *
 * Tests provider management functionality:
 * - getProvider: Get/create/cached provider instances
 * - registerProvider: Register new provider types
 * - setDefaultProvider: Set default provider type
 * - clearProviderCache: Clear cached instances
 * - isProviderAvailable: Check provider availability
 * - getAvailableProviders: Get info about all providers
 * - getDefaultProviderType: Get current default
 *
 * Issue #1617: test: 提升单元测试覆盖率至 70%
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock skills-setup and agents-setup to avoid file system side effects
vi.mock('../utils/skills-setup.js', () => ({
  setupSkillsInWorkspace: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../utils/agents-setup.js', () => ({
  setupAgentsInWorkspace: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import {
  getProvider,
  registerProvider,
  registerProviderClass,
  setDefaultProvider,
  getDefaultProviderType,
  getAvailableProviders,
  clearProviderCache,
  isProviderAvailable,
} from './factory.js';

import type { IAgentSDKProvider, ProviderInfo } from './interface.js';

// Create a mock provider for testing
function createMockProvider(name: string, version: string, isValid: boolean = true): IAgentSDKProvider {
  return {
    name,
    version,
    getInfo: (): ProviderInfo => ({
      name,
      version,
      available: isValid,
      unavailableReason: isValid ? undefined : 'API key not set',
    }),
    queryOnce: async function* () {},
    queryStream: () => ({
      handle: { close: () => {}, cancel: () => {}, sessionId: undefined },
      iterator: (async function* () {})(),
    }),
    createInlineTool: () => null,
    createMcpServer: () => null,
    validateConfig: () => isValid,
    dispose: () => {},
  };
}

describe('getProvider', () => {
  afterEach(() => {
    clearProviderCache();
  });

  it('should return the default provider when no type specified', () => {
    const provider = getProvider();

    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude');
  });

  it('should return cached provider on subsequent calls', () => {
    const provider1 = getProvider('claude');
    const provider2 = getProvider('claude');

    expect(provider1).toBe(provider2); // Same reference (cached)
  });

  it('should throw for unregistered provider type', () => {
    expect(() => getProvider('nonexistent')).toThrow('Unknown provider type');
  });

  it('should throw error that lists available providers', () => {
    expect(() => getProvider('nonexistent')).toThrow(/Available.*claude/);
  });
});

describe('registerProvider', () => {
  afterEach(() => {
    clearProviderCache();
  });

  it('should register a new provider type', () => {
    registerProvider('test', () => createMockProvider('test', '1.0.0'));

    const provider = getProvider('test');
    expect(provider.name).toBe('test');
  });

  it('should clear cache when registering a provider', () => {
    // Get a claude provider first (caches it)
    const provider1 = getProvider('claude');

    // Register a new claude provider (should clear cache)
    registerProvider('claude', () => createMockProvider('claude', '2.0.0'));

    // Get claude again - should be the new one
    const provider2 = getProvider('claude');

    expect(provider1).not.toBe(provider2);
    expect(provider2.version).toBe('2.0.0');
  });
});

describe('registerProviderClass', () => {
  afterEach(() => {
    clearProviderCache();
  });

  it('should register provider from constructor', () => {
    class TestProvider implements IAgentSDKProvider {
      readonly name = 'TestClass';
      readonly version = '3.0.0';
      getInfo() { return { name: this.name, version: this.version, available: true }; }
      async *queryOnce() {}
      queryStream() {
        return {
          handle: { close: () => {}, cancel: () => {}, sessionId: undefined },
          iterator: (async function* () {})(),
        };
      }
      createInlineTool() { return null; }
      createMcpServer() { return null; }
      validateConfig() { return true; }
      dispose() {}
    }

    registerProviderClass('testclass', TestProvider);

    const provider = getProvider('testclass');
    expect(provider.name).toBe('TestClass');
    expect(provider.version).toBe('3.0.0');
  });
});

describe('setDefaultProvider', () => {
  afterEach(() => {
    // Reset to default
    setDefaultProvider('claude');
    clearProviderCache();
  });

  it('should change the default provider type', () => {
    registerProvider('custom', () => createMockProvider('custom', '1.0.0'));
    setDefaultProvider('custom');

    expect(getDefaultProviderType()).toBe('custom');
  });

  it('should throw for unregistered provider type', () => {
    expect(() => setDefaultProvider('nonexistent')).toThrow('Unknown provider type');
  });

  it('should affect getProvider when no type is specified', () => {
    registerProvider('alt', () => createMockProvider('alt', '1.0.0'));
    setDefaultProvider('alt');

    const provider = getProvider();
    expect(provider.name).toBe('alt');
  });
});

describe('getDefaultProviderType', () => {
  it('should return claude by default', () => {
    expect(getDefaultProviderType()).toBe('claude');
  });
});

describe('getAvailableProviders', () => {
  afterEach(() => {
    clearProviderCache();
  });

  it('should return info for all registered providers', () => {
    registerProvider('mock-a', () => createMockProvider('mock-a', '1.0.0', true));
    registerProvider('mock-b', () => createMockProvider('mock-b', '2.0.0', true));

    const infos = getAvailableProviders();

    expect(infos.length).toBeGreaterThanOrEqual(2);
    const mockA = infos.find(i => i.name === 'mock-a');
    const mockB = infos.find(i => i.name === 'mock-b');
    expect(mockA).toBeDefined();
    expect(mockB).toBeDefined();
    expect(mockA!.version).toBe('1.0.0');
    expect(mockB!.version).toBe('2.0.0');
  });

  it('should handle providers that throw during creation', () => {
    registerProvider('broken', () => {
      throw new Error('Factory error');
    });

    const infos = getAvailableProviders();
    const broken = infos.find(i => i.name === 'broken');

    expect(broken).toBeDefined();
    expect(broken!.available).toBe(false);
    expect(broken!.unavailableReason).toContain('Failed to create');
  });
});

describe('clearProviderCache', () => {
  afterEach(() => {
    clearProviderCache();
  });

  it('should clear all cached providers when no type specified', () => {
    const provider1 = getProvider('claude');
    clearProviderCache();
    const provider2 = getProvider('claude');

    expect(provider1).not.toBe(provider2);
  });

  it('should clear only the specified provider type', () => {
    registerProvider('other', () => createMockProvider('other', '1.0.0'));

    const claude1 = getProvider('claude');
    const other1 = getProvider('other');

    clearProviderCache('claude');

    const claude2 = getProvider('claude');
    const other2 = getProvider('other');

    expect(claude1).not.toBe(claude2);
    expect(other1).toBe(other2); // Should still be cached
  });
});

describe('isProviderAvailable', () => {
  afterEach(() => {
    clearProviderCache();
  });

  it('should return false for unregistered provider', () => {
    expect(isProviderAvailable('nonexistent')).toBe(false);
  });

  it('should return true when validateConfig returns true', () => {
    registerProvider('valid', () => createMockProvider('valid', '1.0.0', true));

    expect(isProviderAvailable('valid')).toBe(true);
  });

  it('should return false when validateConfig returns false', () => {
    registerProvider('invalid', () => createMockProvider('invalid', '1.0.0', false));

    expect(isProviderAvailable('invalid')).toBe(false);
  });

  it('should return false when factory throws', () => {
    registerProvider('throws', () => {
      throw new Error('boom');
    });

    expect(isProviderAvailable('throws')).toBe(false);
  });
});
