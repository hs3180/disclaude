/**
 * Tests for Config.validateRequiredConfig() — GLM key present but model missing.
 *
 * Covers the error branch where GLM is auto-detected (no explicit provider)
 * but the model field is empty.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: {},
    // GLM key present but model missing — should throw
    glm: { apiKey: 'glm-no-model-key' },
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

describe('Config.validateRequiredConfig — GLM fallback missing model', () => {
  it('should throw when GLM is fallback but model is missing', () => {
    expect(() => Config.getAgentConfig()).toThrow('glm.model is required');
  });

  it('should have GLM API key but no model', () => {
    expect(Config.GLM_API_KEY).toBe('glm-no-model-key');
    expect(Config.GLM_MODEL).toBe('');
  });
});
