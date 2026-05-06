/**
 * Tests for Config.getModelForTier() — fallback and undefined paths.
 *
 * Covers:
 * - Anthropic fallback to default model when tier model not configured
 * - GLM fallback to default model when tier model not configured
 * - undefined return when no model is configured at all
 *
 * @see Issue #1617 Phase 2
 * @see Issue #3059 (Three-level model configuration)
 */

import { describe, it, expect, vi } from 'vitest';

// ─── Anthropic fallback path ─────────────────────────────────────────────

const { mockAnthropicFallback } = vi.hoisted(() => ({
  mockAnthropicFallback: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
    agent: {
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-20250514',
      // No tier models configured — should fall back to default model
    },
    glm: {},
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockAnthropicFallback,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('Config.getModelForTier — Anthropic fallback', () => {
  it('should fall back to default CLAUDE_MODEL when tier model not configured', () => {
    // No highModel/lowModel/multimodalModel set, should fall back to agent.model
    expect(Config.getModelForTier('high')).toBe('claude-sonnet-4-20250514');
    expect(Config.getModelForTier('low')).toBe('claude-sonnet-4-20250514');
    expect(Config.getModelForTier('multimodal')).toBe('claude-sonnet-4-20250514');
  });
});
