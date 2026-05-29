/**
 * Tests for Config.validateRequiredConfig() — GLM provider without apiKey.
 *
 * Covers:
 * - provider='glm' but no apiKey → throws with field-specific error
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => {
  delete process.env.ANTHROPIC_API_KEY;
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      agent: { provider: 'glm' as const },
      // No GLM apiKey, but model is present
      glm: { model: 'glm-4' },
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

describe('Config.validateRequiredConfig — provider=glm without apiKey', () => {
  it('should throw when provider=glm but apiKey is missing', () => {
    expect(() => Config.getAgentConfig()).toThrow('glm.apiKey is required when agent.provider is "glm"');
  });
});
