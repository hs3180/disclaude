/**
 * Tests for Config.getAgentConfig() — Anthropic fallback path.
 *
 * Covers:
 * - Returns Anthropic config when GLM is not configured but ANTHROPIC_API_KEY is set
 * - No apiBaseUrl in Anthropic config (Anthropic uses env default)
 * - provider is 'anthropic'
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, afterAll } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => {
  // Set ANTHROPIC_API_KEY before module import so it's captured as a static property
  process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic-key-123';
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      // No GLM apiKey — triggers Anthropic fallback
      agent: { model: 'claude-sonnet-4-20250514' },
      glm: {},
      feishu: {},
      workspace: { dir: '/test/workspace' },
    })),
  };
});

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('Config.getAgentConfig — Anthropic fallback path', () => {
  it('should return Anthropic config when GLM is not configured', () => {
    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-test-anthropic-key-123');
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('should not include apiBaseUrl for Anthropic provider', () => {
    const config = Config.getAgentConfig();
    expect(config.apiBaseUrl).toBeUndefined();
  });

  it('should have correct static properties for Anthropic', () => {
    expect(Config.ANTHROPIC_API_KEY).toBe('sk-test-anthropic-key-123');
    expect(Config.CLAUDE_MODEL).toBe('claude-sonnet-4-20250514');
    expect(Config.GLM_API_KEY).toBe('');
  });
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
