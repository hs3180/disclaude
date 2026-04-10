/**
 * Tests for SDK Provider Factory (packages/core/src/sdk/factory.ts)
 *
 * Validates provider registration, caching, retrieval, and lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { IAgentSDKProvider, ProviderFactory } from './interface.js';

// Mock skills/agents setup to prevent side effects
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
  }),
}));

/** Create a mock provider with given name and version */
function createMockProvider(name = 'test', version = '1.0.0', available = true): IAgentSDKProvider {
  return {
    name,
    version,
    getInfo: () => ({ name, version, available, unavailableReason: available ? undefined : 'test reason' }),
    async *queryOnce() { yield { type: 'text', content: '', role: 'assistant' }; },
    queryStream: () => ({
      handle: { close: vi.fn(), cancel: vi.fn(), sessionId: undefined },
      iterator: (async function* () { yield { type: 'text', content: '', role: 'assistant' }; })(),
    }),
    createInlineTool: vi.fn(),
    createMcpServer: vi.fn(),
    validateConfig: () => available,
    dispose: vi.fn(),
  };
}

describe('SDK Factory', () => {
  beforeEach(() => {
    clearProviderCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getProvider', () => {
    it('should return the default claude provider', () => {
      const provider = getProvider();
      expect(provider).toBeDefined();
      expect(provider.name).toBe('claude');
    });

    it('should return cached provider on second call', () => {
      const provider1 = getProvider('claude');
      const provider2 = getProvider('claude');
      expect(provider1).toBe(provider2);
    });

    it('should throw for unknown provider type', () => {
      expect(() => getProvider('nonexistent')).toThrow('Unknown provider type');
    });

    it('should use default provider type when no type specified', () => {
      const provider = getProvider();
      expect(provider.name).toBe(getDefaultProviderType());
    });
  });

  describe('registerProvider', () => {
    it('should register a new provider type', () => {
      const mockFactory: ProviderFactory = () => createMockProvider('custom', '2.0.0');
      registerProvider('custom', mockFactory);

      const provider = getProvider('custom');
      expect(provider.name).toBe('custom');
    });

    it('should clear cache for existing provider type when re-registering', async () => {
      const { ClaudeSDKProvider } = await import('./providers/claude/provider.js');
      const originalFactory = () => new ClaudeSDKProvider();

      const provider1 = getProvider('claude');

      registerProvider('claude', () => createMockProvider('claude-new', '2.0.0'));

      const provider2 = getProvider('claude');
      expect(provider2).not.toBe(provider1);
      expect(provider2.name).toBe('claude-new');

      // Restore original claude provider for other tests
      registerProvider('claude', originalFactory);
    });
  });

  describe('registerProviderClass', () => {
    it('should register provider from constructor', () => {
      class MockProvider implements IAgentSDKProvider {
        readonly name = 'class-provider';
        readonly version = '1.0.0';
        getInfo = () => ({ name: this.name, version: this.version, available: true });
        queryOnce = async function* () {};
        queryStream = () => ({
          handle: { close: vi.fn(), cancel: vi.fn(), sessionId: undefined },
          iterator: (async function* () {})(),
        });
        createInlineTool = vi.fn();
        createMcpServer = vi.fn();
        validateConfig = () => true;
        dispose = vi.fn();
      }

      registerProviderClass('class-provider', MockProvider);
      const provider = getProvider('class-provider');
      expect(provider.name).toBe('class-provider');
    });
  });

  describe('setDefaultProvider', () => {
    afterEach(() => {
      // Reset to claude default
      setDefaultProvider('claude');
    });

    it('should change the default provider type', () => {
      registerProvider('glm', () => createMockProvider('glm'));
      setDefaultProvider('glm');
      expect(getDefaultProviderType()).toBe('glm');
    });

    it('should throw for unregistered provider type', () => {
      expect(() => setDefaultProvider('nonexistent')).toThrow('Unknown provider type');
    });
  });

  describe('getDefaultProviderType', () => {
    it('should return claude by default', () => {
      expect(getDefaultProviderType()).toBe('claude');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return info for claude provider', () => {
      const infos = getAvailableProviders();
      expect(infos.length).toBeGreaterThanOrEqual(1);
      const claudeInfo = infos.find(i => i.name === 'claude');
      expect(claudeInfo).toBeDefined();
    });

    it('should include available=false for failed provider creation', () => {
      registerProvider('broken', () => {
        throw new Error('creation failed');
      });

      const infos = getAvailableProviders();
      const brokenInfo = infos.find(i => i.name === 'broken');
      expect(brokenInfo?.available).toBe(false);
      expect(brokenInfo?.unavailableReason).toContain('Failed to create');
    });
  });

  describe('clearProviderCache', () => {
    it('should clear all provider cache', () => {
      getProvider('claude');
      clearProviderCache();
      // Next call should create a new instance
      const provider = getProvider('claude');
      expect(provider).toBeDefined();
    });

    it('should clear cache for specific provider type', () => {
      registerProvider('a', () => createMockProvider('a'));
      registerProvider('b', () => createMockProvider('b'));

      const a1 = getProvider('a');
      const b1 = getProvider('b');

      clearProviderCache('a');

      const a2 = getProvider('a');
      const b2 = getProvider('b');

      expect(a2).not.toBe(a1); // a was cleared
      expect(b2).toBe(b1);     // b was not cleared
    });
  });

  describe('isProviderAvailable', () => {
    it('should return true for registered provider with valid config', () => {
      registerProvider('valid', () => createMockProvider('valid', '1.0.0', true));
      expect(isProviderAvailable('valid')).toBe(true);
    });

    it('should return false for unregistered provider', () => {
      expect(isProviderAvailable('nonexistent')).toBe(false);
    });

    it('should return false when validateConfig returns false', () => {
      registerProvider('invalid', () => createMockProvider('invalid', '1.0.0', false));
      expect(isProviderAvailable('invalid')).toBe(false);
    });

    it('should return false when factory throws', () => {
      registerProvider('throws', () => {
        throw new Error('fail');
      });
      expect(isProviderAvailable('throws')).toBe(false);
    });
  });
});
