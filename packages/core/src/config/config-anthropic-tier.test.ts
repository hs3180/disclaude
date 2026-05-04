/**
 * Tests for Config.getModelForTier() — Anthropic tier model resolution,
 * session timeout disabled/null path, and SDK timeout default.
 *
 * Covers:
 * - Anthropic tier-specific model resolution (high/low/multimodal) when GLM not configured
 * - Session timeout returning null when not configured
 * - SDK timeout default value
 * - Session restore default values when not configured
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
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
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-20250514',
      highModel: 'claude-opus-4',
      lowModel: 'claude-haiku-4',
      multimodalModel: 'claude-sonnet-4-20250514',
    },
    // No GLM apiKey — Anthropic path is taken
    glm: {},
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
    // No sessionRestore → tests null branch
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

// ─── Anthropic tier model resolution ─────────────────────────────────────

describe('Config.getModelForTier — Anthropic with tier models', () => {
  it('should return Anthropic high model when tier is "high"', () => {
    expect(Config.getModelForTier('high')).toBe('claude-opus-4');
  });

  it('should return Anthropic low model when tier is "low"', () => {
    expect(Config.getModelForTier('low')).toBe('claude-haiku-4');
  });

  it('should return Anthropic multimodal model when tier is "multimodal"', () => {
    expect(Config.getModelForTier('multimodal')).toBe('claude-sonnet-4-20250514');
  });

  it('should not return GLM models when GLM is not configured', () => {
    // Since glm.apiKey is empty, should never enter GLM code path
    expect(Config.getModelForTier('high')).not.toContain('glm');
  });

  it('should return string type for all tier values', () => {
    expect(typeof Config.getModelForTier('high')).toBe('string');
    expect(typeof Config.getModelForTier('low')).toBe('string');
    expect(typeof Config.getModelForTier('multimodal')).toBe('string');
  });
});

// ─── Session timeout disabled/null (uncovered branch 538-539) ────────────

describe('Config.getSessionTimeoutConfig — null when not configured', () => {
  it('should return null when sessionRestore has no sessionTimeout', () => {
    // Our mock has sessionRestore: {} with no sessionTimeout
    expect(Config.getSessionTimeoutConfig()).toBeNull();
  });
});

// ─── SDK timeout default ─────────────────────────────────────────────────

describe('Config.getSdkTimeoutMs — default value', () => {
  it('should return 300000 when sdkTimeoutMs is not configured', () => {
    expect(Config.getSdkTimeoutMs()).toBe(300_000);
  });
});

// ─── Session restore default values ──────────────────────────────────────

describe('Config.getSessionRestoreConfig — default values', () => {
  it('should return default values when sessionRestore is empty', () => {
    const config = Config.getSessionRestoreConfig();
    expect(config).toEqual({
      historyDays: 7,
      maxContextLength: 4000,
    });
  });
});
