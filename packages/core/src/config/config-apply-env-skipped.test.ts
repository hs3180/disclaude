/**
 * Tests for applyGlobalEnv — "skipped" logging branch.
 *
 * Covers the branch at lines 85-89 where:
 * - No new env vars are applied (applied === 0)
 * - All env vars are already set in process.env (skipped > 0)
 * - The "Skipped global env vars" debug log is emitted
 *
 * Uses a mock that provides env vars, then pre-sets them in process.env
 * to trigger the skip path.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Define mock env vars inside vi.hoisted() so they're available before module import
const { mockGetConfigFromFile, mockGetPreloadedConfig, mockEnvKeys } = vi.hoisted(() => {
  const envKeys = ['MOCK_TEST_KEY_A', 'MOCK_TEST_KEY_B'];
  return {
    mockGetConfigFromFile: vi.fn(() => ({
      env: {
        MOCK_TEST_KEY_A: 'value_a',
        MOCK_TEST_KEY_B: 'value_b',
      },
      logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
      agent: {
        provider: 'glm' as const,
      },
      glm: {
        apiKey: 'test-key',
        model: 'glm-4',
      },
      feishu: {},
      workspace: { dir: '/test/workspace' },
    })),
    mockGetPreloadedConfig: vi.fn(() => null),
    mockEnvKeys: envKeys,
  };
});

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: mockGetPreloadedConfig,
}));

import { applyGlobalEnv } from './index.js';

describe('applyGlobalEnv — all env vars already set (skipped path)', () => {
  const keysToClean: string[] = [];

  beforeEach(() => {
    // Pre-set the env vars so applyGlobalEnv will skip them
    for (const key of mockEnvKeys) {
      if (!(key in process.env)) {
        process.env[key] = 'pre-existing-value';
        keysToClean.push(key);
      }
    }
  });

  afterEach(() => {
    for (const key of keysToClean) {
      delete process.env[key];
    }
    keysToClean.length = 0;
  });

  it('should skip all env vars when they already exist in process.env', () => {
    applyGlobalEnv();

    // Values should remain unchanged (not overwritten by config)
    expect(process.env.MOCK_TEST_KEY_A).toBe('pre-existing-value');
    expect(process.env.MOCK_TEST_KEY_B).toBe('pre-existing-value');
  });

  it('should not throw when all env vars are already set', () => {
    expect(() => applyGlobalEnv()).not.toThrow();
  });
});
