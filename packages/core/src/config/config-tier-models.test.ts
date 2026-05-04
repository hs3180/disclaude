/**
 * Tests for Config.getModelForTier() — GLM tier model resolution.
 *
 * Covers the GLM path where GLM_API_KEY is configured:
 * - Tier-specific GLM model resolution (high/low/multimodal)
 * - Preference for GLM over Anthropic tier models
 *
 * @see Issue #1617 Phase 2
 * @see Issue #3059 (Three-level model configuration)
 */

import { describe, it, expect, vi } from 'vitest';

const { mockGetConfigFromFile, mockGetPreloadedConfig } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
    agent: {
      provider: 'glm' as const,
      model: 'claude-sonnet-4-20250514',
      highModel: 'claude-opus-4',
      lowModel: 'claude-haiku-4',
      multimodalModel: 'claude-sonnet-4-20250514',
    },
    glm: {
      apiKey: 'glm-test-key',
      model: 'glm-4',
      highModel: 'glm-4-plus',
      lowModel: 'glm-4-flash',
      multimodalModel: 'glm-4v',
    },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
    sessionRestore: {},
  })),
  mockGetPreloadedConfig: vi.fn(() => null),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: mockGetPreloadedConfig,
}));

import { Config } from './index.js';

describe('Config.getModelForTier — GLM with tier models', () => {
  it('should return GLM high model when tier is "high"', () => {
    expect(Config.getModelForTier('high')).toBe('glm-4-plus');
  });

  it('should return GLM low model when tier is "low"', () => {
    expect(Config.getModelForTier('low')).toBe('glm-4-flash');
  });

  it('should return GLM multimodal model when tier is "multimodal"', () => {
    expect(Config.getModelForTier('multimodal')).toBe('glm-4v');
  });

  it('should prefer GLM tier models over Anthropic tier models when GLM is configured', () => {
    // When GLM is configured (GLM_API_KEY is set), GLM tiers take priority
    // even though Anthropic tier models (claude-opus-4, etc.) are also defined
    expect(Config.getModelForTier('high')).toBe('glm-4-plus');
    expect(Config.getModelForTier('high')).not.toBe('claude-opus-4');
  });

  it('should return string type for all tier values', () => {
    expect(typeof Config.getModelForTier('high')).toBe('string');
    expect(typeof Config.getModelForTier('low')).toBe('string');
    expect(typeof Config.getModelForTier('multimodal')).toBe('string');
  });
});
