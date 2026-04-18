/**
 * Tests for Config.validateRequiredConfig() — GLM fallback (no explicit provider).
 *
 * Covers:
 * - No explicit provider, GLM API key present → returns GLM config
 * - apiBaseUrl included in response when configured
 * - GLM fallback with custom apiBaseUrl
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    // No explicit provider — should auto-detect GLM
    agent: {},
    glm: {
      apiKey: 'glm-fallback-key',
      model: 'glm-4-flash',
      apiBaseUrl: 'https://custom.api.endpoint/v1',
    },
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

describe('Config.validateRequiredConfig — GLM fallback (no explicit provider)', () => {
  it('should fallback to GLM when no explicit provider and GLM apiKey present', () => {
    const config = Config.getAgentConfig();
    expect(config.provider).toBe('glm');
    expect(config.apiKey).toBe('glm-fallback-key');
    expect(config.model).toBe('glm-4-flash');
  });

  it('should include apiBaseUrl in GLM fallback config', () => {
    const config = Config.getAgentConfig();
    expect(config.apiBaseUrl).toBe('https://custom.api.endpoint/v1');
  });

  it('should have GLM_API_BASE_URL from config', () => {
    expect(Config.GLM_API_BASE_URL).toBe('https://custom.api.endpoint/v1');
  });
});
