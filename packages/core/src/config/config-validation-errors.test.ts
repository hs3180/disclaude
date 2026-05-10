/**
 * Tests for Config.getAgentConfig() validation error paths and Anthropic fallback.
 *
 * Covers:
 * - validateRequiredConfig() error-throwing branches (lines 336-345)
 * - Anthropic fallback in getAgentConfig() (lines 377-382)
 *
 * These branches are not covered by config-methods.test.ts because that file
 * mocks a valid GLM config, so validation never fails and the Anthropic
 * fallback is never reached.
 *
 * Uses vi.resetModules() + dynamic import() to re-import Config with different
 * mock configurations per test case.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalApiKey = process.env.ANTHROPIC_API_KEY;

const { mockGetConfigFromFile } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// --- Validation error paths ---

describe('Config getAgentConfig validation errors', () => {
  it('should throw when provider is glm but apiKey is missing', async () => {
    mockGetConfigFromFile.mockReturnValue({
      agent: { provider: 'glm' },
      glm: { model: 'glm-4' },
    });
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('glm.apiKey');
  });

  it('should throw when provider is glm but model is missing', async () => {
    mockGetConfigFromFile.mockReturnValue({
      agent: { provider: 'glm' },
      glm: { apiKey: 'some-key' },
    });
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('glm.model');
  });

  it('should throw when provider is anthropic but ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockGetConfigFromFile.mockReturnValue({
      agent: { provider: 'anthropic', model: 'claude-3' },
    });
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('ANTHROPIC_API_KEY');
  });

  it('should throw when provider is anthropic but model is missing', async () => {
    process.env.ANTHROPIC_API_KEY = 'some-key';
    mockGetConfigFromFile.mockReturnValue({
      agent: { provider: 'anthropic' },
    });
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('agent.model');
  });

  it('should throw when no API key is configured at all', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockGetConfigFromFile.mockReturnValue({});
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('No API key configured');
  });

  it('should include all validation errors in the thrown message', async () => {
    mockGetConfigFromFile.mockReturnValue({
      agent: { provider: 'glm' },
    });
    const { Config } = await import('./index.js');

    try {
      Config.getAgentConfig();
      expect.unreachable('Should have thrown');
    } catch (error) {
      const {message} = (error as Error);
      expect(message).toContain('glm.apiKey');
      expect(message).toContain('glm.model');
    }
  });

  it('should throw when GLM key exists but model is missing (implicit provider)', async () => {
    mockGetConfigFromFile.mockReturnValue({
      glm: { apiKey: 'some-key' },
    });
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('glm.model');
  });

  it('should throw when ANTHROPIC_API_KEY is set but model is missing (implicit provider)', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    mockGetConfigFromFile.mockReturnValue({});
    const { Config } = await import('./index.js');

    expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    expect(() => Config.getAgentConfig()).toThrow('agent.model');
  });
});

// --- Anthropic fallback paths ---

describe('Config getAgentConfig Anthropic fallback', () => {
  it('should return Anthropic config when provider is explicitly anthropic', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    mockGetConfigFromFile.mockReturnValue({
      agent: { provider: 'anthropic', model: 'claude-3-opus' },
    });
    const { Config } = await import('./index.js');

    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('test-anthropic-key');
    expect(config.model).toBe('claude-3-opus');
  });

  it('should fallback to Anthropic when GLM key is not set but ANTHROPIC_API_KEY is', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
    mockGetConfigFromFile.mockReturnValue({
      agent: { model: 'claude-3-sonnet' },
    });
    const { Config } = await import('./index.js');

    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('env-anthropic-key');
    expect(config.model).toBe('claude-3-sonnet');
  });
});
