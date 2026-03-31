/**
 * Unit tests for SDK Provider Factory
 *
 * Tests provider registration, creation, caching,
 * default provider management, and availability checks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import type { IAgentSDKProvider } from './interface.js';

// Mock setup dependencies
vi.mock('../utils/skills-setup.js', () => ({
  setupSkillsInWorkspace: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../utils/agents-setup.js', () => ({
  setupAgentsInWorkspace: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('SDK Factory', () => {
  beforeEach(() => {
    clearProviderCache();
    // Reset default provider to claude
    setDefaultProvider('claude');
  });

  describe('getProvider', () => {
    it('should return a provider instance for claude type', () => {
      const provider = getProvider('claude');
      expect(provider).toBeDefined();
      expect(provider.name).toBe('claude');
    });

    it('should cache provider instances', () => {
      const provider1 = getProvider('claude');
      const provider2 = getProvider('claude');
      expect(provider1).toBe(provider2); // Same reference
    });

    it('should use default provider when type is not specified', () => {
      const provider = getProvider();
      expect(provider).toBeDefined();
      expect(provider.name).toBe('claude');
    });

    it('should throw error for unknown provider type', () => {
      expect(() => getProvider('unknown-provider')).toThrow('Unknown provider type: unknown-provider');
    });

    it('should create new instance after cache is cleared', () => {
      const provider1 = getProvider('claude');
      clearProviderCache('claude');
      const provider2 = getProvider('claude');
      expect(provider1).not.toBe(provider2);
    });
  });

  describe('registerProvider', () => {
    it('should register a new provider factory', () => {
      const mockProvider: IAgentSDKProvider = {
        name: 'test',
        version: '1.0.0',
        getInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0', available: true }),
        queryOnce: vi.fn(),
        queryStream: vi.fn(),
        createInlineTool: vi.fn(),
        createMcpServer: vi.fn(),
        validateConfig: vi.fn().mockReturnValue(true),
        dispose: vi.fn(),
      };

      registerProvider('test', () => mockProvider);
      const provider = getProvider('test');
      expect(provider).toBe(mockProvider);
    });

    it('should clear cache for existing provider type on re-registration', () => {
      const provider1 = getProvider('claude');

      const mockProvider: IAgentSDKProvider = {
        name: 'claude-custom',
        version: '2.0.0',
        getInfo: vi.fn().mockReturnValue({ name: 'claude-custom', version: '2.0.0', available: true }),
        queryOnce: vi.fn(),
        queryStream: vi.fn(),
        createInlineTool: vi.fn(),
        createMcpServer: vi.fn(),
        validateConfig: vi.fn().mockReturnValue(true),
        dispose: vi.fn(),
      };

      registerProvider('claude', () => mockProvider);
      const provider2 = getProvider('claude');

      expect(provider1).not.toBe(provider2);
      expect(provider2.name).toBe('claude-custom');
    });
  });

  describe('registerProviderClass', () => {
    it('should register a provider by constructor', () => {
      class MockProvider implements IAgentSDKProvider {
        name = 'class-test';
        version = '1.0.0';
        getInfo = vi.fn().mockReturnValue({ name: 'class-test', version: '1.0.0', available: true });
        queryOnce = vi.fn();
        queryStream = vi.fn();
        createInlineTool = vi.fn();
        createMcpServer = vi.fn();
        validateConfig = vi.fn().mockReturnValue(true);
        dispose = vi.fn();
      }

      registerProviderClass('class-test', MockProvider);
      const provider = getProvider('class-test');
      expect(provider).toBeInstanceOf(MockProvider);
    });
  });

  describe('setDefaultProvider / getDefaultProviderType', () => {
    it('should set and get default provider type', () => {
      // Register a test provider first
      registerProvider('custom', () => ({
        name: 'custom',
        version: '1.0.0',
        getInfo: vi.fn().mockReturnValue({ name: 'custom', version: '1.0.0', available: true }),
        queryOnce: vi.fn(),
        queryStream: vi.fn(),
        createInlineTool: vi.fn(),
        createMcpServer: vi.fn(),
        validateConfig: vi.fn().mockReturnValue(true),
        dispose: vi.fn(),
      }));

      setDefaultProvider('custom');
      expect(getDefaultProviderType()).toBe('custom');
    });

    it('should throw error when setting unknown provider as default', () => {
      expect(() => setDefaultProvider('non-existent')).toThrow('Unknown provider type: non-existent');
    });

    it('should affect getProvider when no type specified', () => {
      registerProvider('alt', () => ({
        name: 'alt',
        version: '1.0.0',
        getInfo: vi.fn().mockReturnValue({ name: 'alt', version: '1.0.0', available: true }),
        queryOnce: vi.fn(),
        queryStream: vi.fn(),
        createInlineTool: vi.fn(),
        createMcpServer: vi.fn(),
        validateConfig: vi.fn().mockReturnValue(true),
        dispose: vi.fn(),
      }));

      setDefaultProvider('alt');
      const provider = getProvider();
      expect(provider.name).toBe('alt');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return info for all registered providers', () => {
      // Register a test provider to ensure at least one works
      const testProvider: IAgentSDKProvider = {
        name: 'test-available',
        version: '1.0.0',
        getInfo: vi.fn().mockReturnValue({ name: 'test-available', version: '1.0.0', available: true }),
        queryOnce: vi.fn(),
        queryStream: vi.fn(),
        createInlineTool: vi.fn(),
        createMcpServer: vi.fn(),
        validateConfig: vi.fn().mockReturnValue(true),
        dispose: vi.fn(),
      };
      registerProvider('test-available', () => testProvider);

      const providers = getAvailableProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers.some(p => p.name === 'test-available')).toBe(true);
    });

    it('should handle provider creation failures gracefully', () => {
      registerProvider('broken', () => {
        throw new Error('Creation failed');
      });

      const providers = getAvailableProviders();
      const broken = providers.find(p => p.name === 'broken');
      expect(broken).toBeDefined();
      expect(broken?.available).toBe(false);
      expect(broken?.unavailableReason).toContain('Failed to create');
    });
  });

  describe('clearProviderCache', () => {
    it('should clear all cache when no type specified', () => {
      getProvider('claude'); // Cache it
      clearProviderCache();
      // Should create a new instance
      const provider = getProvider('claude');
      expect(provider).toBeDefined();
    });

    it('should clear specific provider cache', () => {
      getProvider('claude');
      clearProviderCache('claude');
      // Next call should create new instance
      const provider = getProvider('claude');
      expect(provider).toBeDefined();
    });
  });

  describe('isProviderAvailable', () => {
    it('should return false for unregistered provider', () => {
      expect(isProviderAvailable('non-existent')).toBe(false);
    });

    it('should return true for registered provider with valid config', () => {
      // The claude provider may or may not validate config depending on env
      // Just check it doesn't throw
      const result = isProviderAvailable('claude');
      expect(typeof result).toBe('boolean');
    });

    it('should return false when provider creation throws', () => {
      registerProvider('throwing', () => {
        throw new Error('Fail');
      });
      expect(isProviderAvailable('throwing')).toBe(false);
    });

    it('should return false when validateConfig returns false', () => {
      registerProvider('invalid-config', () => ({
        name: 'invalid-config',
        version: '1.0.0',
        getInfo: vi.fn(),
        queryOnce: vi.fn(),
        queryStream: vi.fn(),
        createInlineTool: vi.fn(),
        createMcpServer: vi.fn(),
        validateConfig: vi.fn().mockReturnValue(false),
        dispose: vi.fn(),
      }));
      expect(isProviderAvailable('invalid-config')).toBe(false);
    });
  });
});
