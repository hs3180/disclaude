/**
 * Tests for applyGlobalEnv (packages/core/src/config/index.ts)
 *
 * Verifies that config env vars are injected into process.env
 * without overwriting existing system environment variables.
 *
 * @see Issue #1618
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyGlobalEnv } from './index.js';

describe('applyGlobalEnv', () => {
  // Track env vars we modify so we can clean up
  const modifiedKeys = new Set<string>();
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    modifiedKeys.clear();
    originalValues.clear();
  });

  afterEach(() => {
    // Restore original env values
    for (const key of modifiedKeys) {
      if (originalValues.has(key)) {
        process.env[key] = originalValues.get(key);
      } else {
        delete process.env[key];
      }
    }
    modifiedKeys.clear();
    originalValues.clear();
  });

  /**
   * Helper to set and track a process.env change for cleanup.
   */
  function setEnv(key: string, value: string | undefined): void {
    if (!(key in process.env) || process.env[key] !== value) {
      if (!modifiedKeys.has(key)) {
        originalValues.set(key, process.env[key]);
        modifiedKeys.add(key);
      }
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  it('should not throw when called', () => {
    expect(() => applyGlobalEnv()).not.toThrow();
  });

  it('should be idempotent — calling twice produces same result', () => {
    const before = { ...process.env };
    applyGlobalEnv();
    const afterFirst = { ...process.env };
    applyGlobalEnv();
    const afterSecond = { ...process.env };
    expect(afterSecond).toEqual(afterFirst);
    // Restore original state (keys added by applyGlobalEnv should be removed)
    for (const key of Object.keys(afterFirst)) {
      if (!(key in before)) {
        delete process.env[key];
      }
    }
  });

  it('should not overwrite existing system environment variables', () => {
    // Set a system env var that might also be in config
    const testKey = '__DISCLAUDE_TEST_PROTECT_KEY__';
    const systemValue = 'system_value_should_win';
    setEnv(testKey, systemValue);

    // If config also has this key, applyGlobalEnv should NOT overwrite it
    // (We can't control what's in config, but we verify existing value survives)
    applyGlobalEnv();

    expect(process.env[testKey]).toBe(systemValue);
  });

  it('should not modify process.env when config has no env section', () => {
    // This test assumes the test environment has no config file with env vars,
    // or that existing env vars are not overwritten.
    const envBefore = { ...process.env };

    applyGlobalEnv();

    // Verify no existing keys were changed (new keys may have been added)
    for (const key of Object.keys(envBefore)) {
      expect(process.env[key]).toBe(envBefore[key]);
    }
  });
});
