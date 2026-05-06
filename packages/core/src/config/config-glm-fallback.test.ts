/**
 * Tests for Config.getModelForTier() — GLM fallback to default and undefined paths.
 *
 * Covers:
 * - GLM fallback to default GLM_MODEL when tier model not configured
 * - undefined return when no model at all is configured
 *
 * @see Issue #1617 Phase 2
 * @see Issue #3059 (Three-level model configuration)
 */

import { describe, it, expect, vi } from 'vitest';

// ─── GLM fallback path ───────────────────────────────────────────────────

const { mockGlmFallback } = vi.hoisted(() => ({
  mockGlmFallback: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
    agent: {
      provider: 'glm' as const,
      model: 'claude-sonnet-4-20250514',
    },
    glm: {
      apiKey: 'glm-test-key',
      model: 'glm-4',
      // No tier models configured — should fall back to glm.model
    },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGlmFallback,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('Config.getModelForTier — GLM fallback', () => {
  it('should fall back to default GLM_MODEL when tier model not configured', () => {
    expect(Config.getModelForTier('high')).toBe('glm-4');
    expect(Config.getModelForTier('low')).toBe('glm-4');
    expect(Config.getModelForTier('multimodal')).toBe('glm-4');
  });
});
