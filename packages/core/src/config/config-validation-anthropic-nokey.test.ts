/**
 * Tests for Config.validateRequiredConfig() — Anthropic provider without ANTHROPIC_API_KEY.
 *
 * Covers:
 * - provider='anthropic' but ANTHROPIC_API_KEY env var not set → throws
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => {
  // Ensure ANTHROPIC_API_KEY is not set
  delete process.env.ANTHROPIC_API_KEY;
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      agent: {
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
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

describe('Config.validateRequiredConfig — provider=anthropic without ANTHROPIC_API_KEY', () => {
  it('should throw when provider=anthropic but ANTHROPIC_API_KEY is not set', () => {
    expect(() => Config.getAgentConfig()).toThrow('ANTHROPIC_API_KEY environment variable is required');
  });

  it('should include field name in error', () => {
    try {
      Config.getAgentConfig();
      expect.unreachable('Should have thrown');
    } catch (error) {
      const {message} = (error as Error);
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).toContain('Configuration validation failed');
    }
  });
});
