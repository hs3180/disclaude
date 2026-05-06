/**
 * Tests for Config.getModelForTier() — undefined return path.
 *
 * Covers:
 * - Returns undefined when no model is configured at all (neither tier nor default)
 *
 * @see Issue #1617 Phase 2
 * @see Issue #3059 (Three-level model configuration)
 */

import { describe, it, expect, vi } from 'vitest';

const { mockNoModel } = vi.hoisted(() => ({
  mockNoModel: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
    agent: {
      provider: 'anthropic' as const,
      // No model, no tier models — all empty
    },
    glm: {},
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockNoModel,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('Config.getModelForTier — undefined when no model configured', () => {
  it('should return undefined when no tier model and no default model are configured', () => {
    expect(Config.getModelForTier('high')).toBeUndefined();
    expect(Config.getModelForTier('low')).toBeUndefined();
    expect(Config.getModelForTier('multimodal')).toBeUndefined();
  });
});
