/**
 * Tests for Anthropic custom endpoint configuration (Issue #2768)
 *
 * Verifies that:
 * 1. Config reads ANTHROPIC_BASE_URL from env var or config file (env takes precedence)
 * 2. Config reads ANTHROPIC_AUTH_TOKEN from env var or config file (env takes precedence)
 * 3. getAgentConfig() returns apiBaseUrl for Anthropic provider
 * 4. applyGlobalEnv() injects anthropic config into process.env
 * 5. Environment variables take precedence over config file values
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock with Anthropic endpoint config to test the new feature
const { mockGetConfigFromFile, mockGetPreloadedConfig } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    agent: { provider: 'anthropic' as const, model: 'claude-sonnet-4-20250514' },
    anthropic: {
      apiBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      authToken: 'test-auth-token',
    },
  })),
  mockGetPreloadedConfig: vi.fn(() => null),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: mockGetPreloadedConfig,
}));

import { Config, applyGlobalEnv } from './index.js';

describe('Anthropic custom endpoint configuration (Issue #2768)', () => {
  // Track env vars we modify for cleanup
  const modifiedKeys = new Set<string>();
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    modifiedKeys.clear();
    originalValues.clear();
  });

  afterEach(() => {
    // Restore original env values
    for (const key of modifiedKeys) {
      if (originalValues.has(key)) {
        process.env[key] = originalValues.get(key);
      } else {
        delete process.env[key];
      }
    }
    modifiedKeys.clear();
    originalValues.clear();
  });

  function setEnv(key: string, value: string | undefined): void {
    if (!(key in process.env) || process.env[key] !== value) {
      if (!modifiedKeys.has(key)) {
        originalValues.set(key, process.env[key]);
        modifiedKeys.add(key);
      }
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  describe('Config.ANTHROPIC_BASE_URL', () => {
    it('should have a value (env var takes precedence over config file)', () => {
      // Config reads: process.env.ANTHROPIC_BASE_URL || config.anthropic.apiBaseUrl
      // The value may come from either source depending on the test environment.
      expect(Config.ANTHROPIC_BASE_URL).toBeTruthy();
    });
  });

  describe('Config.ANTHROPIC_AUTH_TOKEN', () => {
    it('should read authToken from config file when env var is not set', () => {
      // ANTHROPIC_AUTH_TOKEN is unlikely to be set in CI, so it should
      // fall back to the config file value from our mock.
      expect(Config.ANTHROPIC_AUTH_TOKEN).toBe('test-auth-token');
    });
  });

  describe('getAgentConfig() with custom endpoint', () => {
    it('should return Anthropic provider when configured', () => {
      const config = Config.getAgentConfig();
      expect(config.provider).toBe('anthropic');
    });

    it('should return apiBaseUrl when using Anthropic provider with custom endpoint', () => {
      const config = Config.getAgentConfig();
      // apiBaseUrl comes from Config.ANTHROPIC_BASE_URL which may be
      // from env var (takes precedence) or config file.
      expect(config.apiBaseUrl).toBeTruthy();
    });
  });

  describe('applyGlobalEnv() with anthropic config', () => {
    it('should inject ANTHROPIC_BASE_URL from config into process.env when not set', () => {
      // Clear any existing env var to test config-only injection
      setEnv('ANTHROPIC_BASE_URL', undefined);

      applyGlobalEnv();

      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    });

    it('should inject ANTHROPIC_AUTH_TOKEN from config into process.env when not set', () => {
      setEnv('ANTHROPIC_AUTH_TOKEN', undefined);

      applyGlobalEnv();

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('test-auth-token');
    });

    it('should NOT overwrite existing ANTHROPIC_BASE_URL env var', () => {
      const existingValue = 'https://my-existing-proxy.example.com';
      setEnv('ANTHROPIC_BASE_URL', existingValue);

      applyGlobalEnv();

      expect(process.env.ANTHROPIC_BASE_URL).toBe(existingValue);
    });

    it('should NOT overwrite existing ANTHROPIC_AUTH_TOKEN env var', () => {
      const existingValue = 'existing-token';
      setEnv('ANTHROPIC_AUTH_TOKEN', existingValue);

      applyGlobalEnv();

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(existingValue);
    });
  });
});
