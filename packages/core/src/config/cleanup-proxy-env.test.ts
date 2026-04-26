/**
 * Tests for cleanupProxyEnvVars (packages/core/src/config/index.ts)
 *
 * Verifies that proxy-specific environment variables are properly
 * cleaned up when using a custom Anthropic-compatible endpoint.
 *
 * @see Issue #2768
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanupProxyEnvVars } from './index.js';

describe('cleanupProxyEnvVars', () => {
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

  it('should not throw when called (no anthropic config)', () => {
    // Remove any proxy-specific env vars
    setEnv('ANTHROPIC_CUSTOM_HEADERS', undefined);
    setEnv('ANTHROPIC_BASE_URL', undefined);

    expect(() => cleanupProxyEnvVars()).not.toThrow();
  });

  it('should be safe to call when no proxy env vars exist', () => {
    setEnv('ANTHROPIC_CUSTOM_HEADERS', undefined);
    setEnv('ANTHROPIC_BASE_URL', undefined);

    const before = { ...process.env };
    cleanupProxyEnvVars();
    const after = { ...process.env };

    // No changes expected when no anthropic config is present
    expect(after).toEqual(before);
  });

  it('should not modify env vars when no anthropic config section exists', () => {
    // Set some proxy-specific env vars
    setEnv('ANTHROPIC_CUSTOM_HEADERS', 'comate_custom_header=some-value');
    setEnv('ANTHROPIC_BASE_URL', 'https://oneapi-comate.baidu-int.com/api/anthropic');

    const headersBefore = process.env.ANTHROPIC_CUSTOM_HEADERS;
    const urlBefore = process.env.ANTHROPIC_BASE_URL;

    cleanupProxyEnvVars();

    // Without anthropic config section, env vars should be unchanged
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(headersBefore);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(urlBefore);
  });
});
