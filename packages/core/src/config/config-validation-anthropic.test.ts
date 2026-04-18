/**
 * Tests for Config.validateRequiredConfig() — Anthropic provider paths.
 *
 * Covers:
 * - Anthropic provider with API key and model configured → returns Anthropic config
 * - Verifies ANTHROPIC_API_KEY is read from process.env
 * - Verifies CLAUDE_MODEL is read from config
 *
 * Note: In environments where ANTHROPIC_API_KEY is set in process.env,
 * the Anthropic provider path succeeds. This test covers that happy path.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

// Mock with Anthropic provider configuration
vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: { provider: 'anthropic' as const, model: 'claude-sonnet-4-20250514' },
    // No GLM config — should use Anthropic
    workspace: { dir: '/test/workspace' },
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string) => {
    if (cmd === 'which') {return '/usr/local/bin/claude-agent-acp';}
    return '';
  }),
}));

import { Config } from './index.js';

describe('Config.validateRequiredConfig — Anthropic provider', () => {
  it('should return Anthropic config when provider is anthropic with valid env', () => {
    // ANTHROPIC_API_KEY comes from process.env
    const config = Config.getAgentConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('should read ANTHROPIC_API_KEY from process.env', () => {
    expect(Config.ANTHROPIC_API_KEY).toBeTruthy();
  });

  it('should have CLAUDE_MODEL from config', () => {
    expect(Config.CLAUDE_MODEL).toBe('claude-sonnet-4-20250514');
  });

  it('should have empty GLM config when not in config file', () => {
    expect(Config.GLM_API_KEY).toBe('');
    expect(Config.GLM_MODEL).toBe('');
  });

  it('should not include apiBaseUrl for Anthropic provider', () => {
    const config = Config.getAgentConfig();
    expect(config.apiBaseUrl).toBeUndefined();
  });
});
