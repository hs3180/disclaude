/**
 * Tests for Config.validateRequiredConfig() — Anthropic fallback (no explicit provider).
 *
 * Covers:
 * - No explicit provider, no GLM key → falls back to Anthropic from env
 * - Anthropic fallback but no agent.model configured → error
 * - Verifies fallback detection logic
 *
 * Note: In test environments where ANTHROPIC_API_KEY is set in process.env,
 * the Anthropic fallback path is exercised rather than the "No API key" error.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    // No explicit provider, no GLM key → fallback to Anthropic from env
    agent: {},
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

describe('Config.validateRequiredConfig — Anthropic fallback (no provider)', () => {
  it('should have empty GLM config', () => {
    expect(Config.GLM_API_KEY).toBe('');
    expect(Config.GLM_MODEL).toBe('');
  });

  it('should throw about missing model when falling back to Anthropic from env', () => {
    // ANTHROPIC_API_KEY is set in env but agent.model is not in config
    // This hits the "ANTHROPIC_API_KEY is set but model missing" branch
    expect(() => Config.getAgentConfig()).toThrow('agent.model is required');
  });
});
