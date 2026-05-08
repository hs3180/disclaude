/**
 * Tests for Config Anthropic fallback path in getAgentConfig().
 *
 * This file covers lines 365-370 in packages/core/src/config/index.ts —
 * the Anthropic provider fallback when GLM is not configured.
 *
 * Uses a separate test file because Config uses module-level static
 * initialization. The mock here configures Anthropic-only (no GLM),
 * while config-methods.test.ts configures GLM.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

// Mock: Anthropic-only config (no GLM)
vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: true },
    agent: { provider: 'anthropic' as const, model: 'claude-sonnet-4-20250514' },
    glm: {},
    feishu: {},
    workspace: {},
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('Config getAgentConfig — Anthropic fallback', () => {
  it('should return Anthropic config when GLM is not configured', () => {
    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe(process.env.ANTHROPIC_API_KEY || '');
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('should not include apiBaseUrl for Anthropic provider', () => {
    const config = Config.getAgentConfig();
    expect(config.apiBaseUrl).toBeUndefined();
  });

  it('should return correct Anthropic API key', () => {
    const config = Config.getAgentConfig();
    // ANTHROPIC_API_KEY is read from process.env at module init time
    expect(typeof config.apiKey).toBe('string');
  });
});
