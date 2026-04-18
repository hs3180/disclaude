/**
 * Tests for Config.getSessionTimeoutConfig() — partial config with defaults.
 *
 * Covers:
 * - sessionTimeout.enabled = true but no other fields → uses defaults
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: { provider: 'glm' as const },
    glm: { apiKey: 'test-key', model: 'glm-4' },
    workspace: { dir: '/test/workspace' },
    sessionRestore: {
      sessionTimeout: { enabled: true },
    },
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

describe('Config.getSessionTimeoutConfig — defaults', () => {
  it('should use default values when only enabled is set', () => {
    const config = Config.getSessionTimeoutConfig();
    expect(config).toEqual({
      enabled: true,
      idleMinutes: 30,
      maxSessions: 100,
      checkIntervalMinutes: 5,
    });
  });
});
