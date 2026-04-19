/**
 * Tests for Config.getAgentConfig() Anthropic provider path
 *
 * Covers the Anthropic fallback branch (lines 358-363 of index.ts):
 * - When no GLM is configured but ANTHROPIC_API_KEY is set
 * - getAgentConfig() should return anthropic provider config
 *
 * Note: Config static properties are computed at module import time.
 * ANTHROPIC_API_KEY is read from process.env at import. The mock omits
 * GLM config to trigger the Anthropic fallback path.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    agent: { model: 'claude-3-opus' },
    // No GLM config — triggers Anthropic fallback
    feishu: {},
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'which' && args[0] === 'claude-agent-acp') {
      return '/usr/local/bin/claude-agent-acp';
    }
    return '';
  }),
}));

import { Config } from './index.js';

// Capture whatever ANTHROPIC_API_KEY was at module import time
const capturedApiKey = Config.ANTHROPIC_API_KEY;

describe('Config.getAgentConfig — Anthropic fallback', () => {
  it('should return Anthropic provider when GLM is not configured', () => {
    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe(capturedApiKey);
    expect(config.model).toBe('claude-3-opus');
  });

  it('should not include apiBaseUrl for Anthropic provider', () => {
    const config = Config.getAgentConfig();
    expect(config.apiBaseUrl).toBeUndefined();
  });

  it('should use the same API key stored in Config.ANTHROPIC_API_KEY', () => {
    const config = Config.getAgentConfig();
    expect(config.apiKey).toBe(Config.ANTHROPIC_API_KEY);
  });
});

describe('Config static properties — Anthropic mode', () => {
  it('should have ANTHROPIC_API_KEY set from environment', () => {
    // Verifies the key was captured at import time
    expect(typeof Config.ANTHROPIC_API_KEY).toBe('string');
  });

  it('should have CLAUDE_MODEL from config', () => {
    expect(Config.CLAUDE_MODEL).toBe('claude-3-opus');
  });

  it('should have empty GLM config when not in config file', () => {
    expect(Config.GLM_API_KEY).toBe('');
    expect(Config.GLM_MODEL).toBe('');
  });

  it('should have isAgentTeamsEnabled default to false when not set', () => {
    expect(Config.isAgentTeamsEnabled()).toBe(false);
  });
});

describe('Config.getSessionTimeoutConfig — disabled', () => {
  it('should return null when no sessionTimeout is configured', () => {
    // This covers line 489-490 (return null path)
    expect(Config.getSessionTimeoutConfig()).toBeNull();
  });
});

describe('Config.getSessionRestoreConfig — defaults', () => {
  it('should return default values when not configured', () => {
    const config = Config.getSessionRestoreConfig();
    expect(config.historyDays).toBe(7);
    expect(config.maxContextLength).toBe(4000);
  });
});
