/**
 * Tests for Config validation error paths (validateRequiredConfig).
 *
 * Covers all branches of the private validateRequiredConfig() method,
 * tested indirectly through getAgentConfig():
 *
 * - provider='glm' + missing apiKey
 * - provider='glm' + missing model
 * - provider='anthropic' + missing ANTHROPIC_API_KEY
 * - provider='anthropic' + missing agent.model
 * - No explicit provider + GLM apiKey present but no model
 * - No explicit provider + ANTHROPIC_API_KEY present but no agent.model
 * - No provider at all (no API key configured)
 *
 * Uses vi.resetModules() + dynamic import() to test different config
 * scenarios within a single test file, since Config computes its static
 * properties at module import time.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Helper to set up loader mock and dynamically import Config.
 * Each call re-creates the module with fresh static properties.
 *
 * @param configFromFile - The config object returned by getConfigFromFile()
 * @param envOverrides - Optional env vars to set before import (e.g. ANTHROPIC_API_KEY)
 */
async function importConfigWith(
  configFromFile: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): Promise<typeof import('./index.js')> {
  vi.resetModules();

  // Set env overrides before module import
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }

  vi.doMock('./loader.js', () => ({
    loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
    getConfigFromFile: vi.fn(() => configFromFile),
    validateConfig: vi.fn(() => true),
    getPreloadedConfig: vi.fn(() => null),
  }));

  const mod = await import('./index.js');
  return mod;
}

describe('Config.validateRequiredConfig — error paths via getAgentConfig()', () => {
  const envKeysToClean: string[] = [];

  afterEach(() => {
    // Clean up any env vars we set
    for (const key of envKeysToClean) {
      delete process.env[key];
    }
    envKeysToClean.length = 0;
    vi.restoreAllMocks();
  });

  // ─── provider='glm' validation ─────────────────────────────────────────

  describe('provider=glm', () => {
    it('should throw when GLM API key is missing', async () => {
      const { Config } = await importConfigWith({
        agent: { provider: 'glm' },
        glm: {
          model: 'glm-4',
          // No apiKey
        },
      });

      expect(() => Config.getAgentConfig()).toThrow(/glm\.apiKey is required/);
    });

    it('should throw when GLM model is missing', async () => {
      const { Config } = await importConfigWith({
        agent: { provider: 'glm' },
        glm: {
          apiKey: 'test-glm-key',
          // No model
        },
      });

      expect(() => Config.getAgentConfig()).toThrow(/glm\.model is required/);
    });
  });

  // ─── provider='anthropic' validation ───────────────────────────────────

  describe('provider=anthropic', () => {
    it('should throw when ANTHROPIC_API_KEY env var is missing', async () => {
      // Ensure ANTHROPIC_API_KEY is NOT set before import
      delete process.env.ANTHROPIC_API_KEY;

      vi.resetModules();
      vi.doMock('./loader.js', () => ({
        loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
        getConfigFromFile: vi.fn(() => ({
          agent: { provider: 'anthropic', model: 'claude-sonnet-4' },
          glm: {},
        })),
        validateConfig: vi.fn(() => true),
        getPreloadedConfig: vi.fn(() => null),
      }));

      const { Config } = await import('./index.js');

      expect(() => Config.getAgentConfig()).toThrow(/ANTHROPIC_API_KEY.*required/);
    });

    it('should throw when agent.model is missing with anthropic provider', async () => {
      const { Config } = await importConfigWith({
        agent: { provider: 'anthropic' },
        glm: {},
      }, {
        ANTHROPIC_API_KEY: 'sk-test-key',
      });

      envKeysToClean.push('ANTHROPIC_API_KEY');

      expect(() => Config.getAgentConfig()).toThrow(/agent\.model is required/);
    });
  });

  // ─── No explicit provider — GLM fallback ───────────────────────────────

  describe('no explicit provider — GLM configured', () => {
    it('should throw when GLM API key is present but model is missing', async () => {
      const { Config } = await importConfigWith({
        // No provider specified
        agent: {},
        glm: {
          apiKey: 'glm-test-key',
          // No model
        },
      });

      expect(() => Config.getAgentConfig()).toThrow(/glm\.model is required/);
    });
  });

  // ─── No explicit provider — Anthropic fallback ─────────────────────────

  describe('no explicit provider — Anthropic fallback', () => {
    it('should throw when ANTHROPIC_API_KEY is present but agent.model is missing', async () => {
      const { Config } = await importConfigWith({
        agent: {},
        glm: {},
      }, {
        ANTHROPIC_API_KEY: 'sk-test-key',
      });

      envKeysToClean.push('ANTHROPIC_API_KEY');

      expect(() => Config.getAgentConfig()).toThrow(/agent\.model is required.*ANTHROPIC_API_KEY/);
    });
  });

  // ─── No API key at all ─────────────────────────────────────────────────

  describe('no API key configured', () => {
    it('should throw when no API key is configured at all', async () => {
      vi.resetModules();

      // Ensure no ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY;

      vi.doMock('./loader.js', () => ({
        loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
        getConfigFromFile: vi.fn(() => ({
          agent: {},
          glm: {},
        })),
        validateConfig: vi.fn(() => true),
        getPreloadedConfig: vi.fn(() => null),
      }));

      const { Config } = await import('./index.js');

      expect(() => Config.getAgentConfig()).toThrow(/No API key configured/);
    });
  });
});
