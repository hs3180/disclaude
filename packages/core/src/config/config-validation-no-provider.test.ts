/**
 * Tests for Config.validateRequiredConfig() — no provider configured.
 *
 * Covers:
 * - Throws error when no API key is configured at all
 * - Error message mentions both config file and env var options
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => {
  // Ensure no API keys are set
  delete process.env.ANTHROPIC_API_KEY;
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      // No provider, no GLM apiKey, no Anthropic
      agent: {},
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

describe('Config.validateRequiredConfig — no provider at all', () => {
  it('should throw when no API key is configured', () => {
    expect(() => Config.getAgentConfig()).toThrow('No API key configured');
  });

  it('should mention both config file and env var in error message', () => {
    try {
      Config.getAgentConfig();
      expect.unreachable('Should have thrown');
    } catch (error) {
      const {message} = (error as Error);
      expect(message).toContain('glm.apiKey');
      expect(message).toContain('disclaude.config.yaml');
      expect(message).toContain('ANTHROPIC_API_KEY');
    }
  });
});
