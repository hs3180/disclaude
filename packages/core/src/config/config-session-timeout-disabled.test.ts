/**
 * Tests for Config.getSessionTimeoutConfig() — explicitly disabled and partial config.
 *
 * Covers:
 * - sessionTimeout.enabled = false → returns null
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
      sessionTimeout: { enabled: false },
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

describe('Config.getSessionTimeoutConfig — explicitly disabled', () => {
  it('should return null when sessionTimeout.enabled is false', () => {
    expect(Config.getSessionTimeoutConfig()).toBeNull();
  });
});
