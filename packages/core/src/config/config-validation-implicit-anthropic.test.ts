/**
 * Tests for Config.validateRequiredConfig() — implicit Anthropic without model.
 *
 * Covers:
 * - No explicit provider, no GLM, ANTHROPIC_API_KEY set in env, but no agent.model → throws
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, afterAll } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic-key';
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      // No explicit provider, no GLM, ANTHROPIC_API_KEY in env
      agent: {},
      // No model — should trigger implicit Anthropic validation error
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

describe('Config.validateRequiredConfig — implicit Anthropic without model', () => {
  it('should throw when ANTHROPIC_API_KEY set but no agent.model', () => {
    expect(() => Config.getAgentConfig()).toThrow('agent.model is required when using Anthropic');
  });
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
