/**
 * Tests for Config.getAgentConfig() — Anthropic provider path.
 *
 * Covers the Anthropic fallback branch (lines 364-370) when:
 * - GLM_API_KEY is not configured
 * - ANTHROPIC_API_KEY is set via environment variable
 * - agent.model is configured
 *
 * Also covers the Anthropic tier model fallback path when no tier-specific
 * model is configured.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Set ANTHROPIC_API_KEY inside vi.hoisted() so it's available before import
const { mockGetConfigFromFile, originalAnthropicKey } = vi.hoisted(() => {
  const orig = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-for-anthropic-agent-test';
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      env: {},
      logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
      agent: {
        model: 'claude-sonnet-4-20250514',
        // No provider specified — should fall back to Anthropic
      },
      // No GLM apiKey — triggers Anthropic fallback
      glm: {},
      feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
      workspace: { dir: '/test/workspace' },
    })),
    originalAnthropicKey: orig,
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
  afterEach(() => {
    // Restore original env var
    if (originalAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('should return Anthropic config when GLM is not configured', () => {
    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-ant-test-key-for-anthropic-agent-test');
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('should not include apiBaseUrl for Anthropic provider', () => {
    const config = Config.getAgentConfig();
    expect(config.apiBaseUrl).toBeUndefined();
  });
});

describe('Config.getModelForTier — Anthropic fallback (no tier models)', () => {
  it('should fall back to default CLAUDE_MODEL when no Anthropic tier model configured', () => {
    expect(Config.getModelForTier('high')).toBe('claude-sonnet-4-20250514');
    expect(Config.getModelForTier('low')).toBe('claude-sonnet-4-20250514');
    expect(Config.getModelForTier('multimodal')).toBe('claude-sonnet-4-20250514');
  });
});
