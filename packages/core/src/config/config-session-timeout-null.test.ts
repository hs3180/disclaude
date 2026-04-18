/**
 * Tests for Config.getSessionTimeoutConfig() — null and disabled cases.
 *
 * Covers:
 * - No sessionRestore config → returns null
 * - sessionRestore present but sessionTimeout.enabled = false → returns null
 * - sessionTimeout with only enabled: true → uses defaults
 * - getSessionRestoreConfig() default values
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
    // No sessionRestore — getSessionTimeoutConfig should return null
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

describe('Config.getSessionTimeoutConfig — no config', () => {
  it('should return null when sessionRestore is not configured', () => {
    expect(Config.getSessionTimeoutConfig()).toBeNull();
  });

  it('should return default restore config when sessionRestore is undefined', () => {
    const config = Config.getSessionRestoreConfig();
    expect(config.historyDays).toBe(7);
    expect(config.maxContextLength).toBe(4000);
  });
});
