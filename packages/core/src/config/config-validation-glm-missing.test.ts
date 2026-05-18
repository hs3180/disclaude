/**
 * Tests for Config.validateRequiredConfig() — GLM provider missing fields.
 *
 * Covers:
 * - provider='glm' but no apiKey → throws with specific field error
 * - provider='glm' but no model → throws with specific field error
 * - Error message includes field name and description
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
      // GLM apiKey is set but model is missing
      glm: { apiKey: 'test-glm-key' },
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

describe('Config.validateRequiredConfig — provider=glm without model', () => {
  it('should throw when provider=glm but model is missing', () => {
    expect(() => Config.getAgentConfig()).toThrow('glm.model is required');
  });

  it('should include the field name in the error', () => {
    try {
      Config.getAgentConfig();
      expect.unreachable('Should have thrown');
    } catch (error) {
      const {message} = (error as Error);
      expect(message).toContain('glm.model');
      expect(message).toContain('Configuration validation failed');
    }
  });
});
