/**
 * Tests for Config.validateRequiredConfig() — implicit GLM provider without model.
 *
 * Covers:
 * - No explicit provider, GLM apiKey present in config, but model missing → throws
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
      // No explicit provider, but GLM apiKey is present
      agent: {},
      glm: { apiKey: 'test-glm-key' },
      // No model — should trigger implicit GLM validation error
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

describe('Config.validateRequiredConfig — implicit GLM without model', () => {
  it('should throw when GLM apiKey present but model is missing', () => {
    expect(() => Config.getAgentConfig()).toThrow('glm.model is required when GLM API key is configured');
  });
});
