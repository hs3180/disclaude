/**
 * Tests for applyGlobalEnv() — env var injection with system env precedence.
 *
 * Covers:
 * - Env vars from config are set to process.env
 * - Existing process.env values are NOT overridden
 * - Env vars that are already set are skipped
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {
      APPLY_ENV_TEST_1: 'config_value_1',
      APPLY_ENV_TEST_2: 'config_value_2',
    },
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: { provider: 'glm' as const },
    glm: { apiKey: 'test-key', model: 'glm-4' },
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

import { applyGlobalEnv } from './index.js';

describe('applyGlobalEnv', () => {
  afterEach(() => {
    delete process.env.APPLY_ENV_TEST_1;
    delete process.env.APPLY_ENV_TEST_2;
  });

  it('should set env vars from config to process.env', () => {
    applyGlobalEnv();
    expect(process.env.APPLY_ENV_TEST_1).toBe('config_value_1');
    expect(process.env.APPLY_ENV_TEST_2).toBe('config_value_2');
  });

  it('should not override existing process.env values', () => {
    process.env.APPLY_ENV_TEST_1 = 'system_value';
    applyGlobalEnv();
    expect(process.env.APPLY_ENV_TEST_1).toBe('system_value');
    // Second var should still be set from config
    expect(process.env.APPLY_ENV_TEST_2).toBe('config_value_2');
  });

  it('should handle being called multiple times (idempotent)', () => {
    applyGlobalEnv();
    applyGlobalEnv();
    expect(process.env.APPLY_ENV_TEST_1).toBe('config_value_1');
  });
});
