/**
 * Tests for Config.validateRequiredConfig() — Anthropic provider missing fields.
 *
 * Covers:
 * - provider='anthropic' but no ANTHROPIC_API_KEY → throws
 * - provider='anthropic' but no agent.model → throws
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, afterAll } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => {
  // Set ANTHROPIC_API_KEY so the model-missing branch is reached
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      agent: {
        provider: 'anthropic' as const,
        // No model — should throw
      },
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

describe('Config.validateRequiredConfig — provider=anthropic without model', () => {
  it('should throw when provider=anthropic but no agent.model', () => {
    expect(() => Config.getAgentConfig()).toThrow('agent.model is required when using Anthropic provider');
  });

  it('should include ANTHROPIC_API_KEY reference in error', () => {
    try {
      Config.getAgentConfig();
      expect.unreachable('Should have thrown');
    } catch (error) {
      const {message} = (error as Error);
      expect(message).toContain('agent.model');
      expect(message).toContain('Configuration validation failed');
    }
  });
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
