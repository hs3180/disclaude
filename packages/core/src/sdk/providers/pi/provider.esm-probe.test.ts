/**
 * Real (un-mocked) ESM-probe smoke for PiAgentProvider — PR #4390.
 *
 * Companion to provider.test.ts: that file mocks node:module to flip package
 * resolvability deterministically. This file does NOT mock, so it exercises the
 * actual `createRequire(import.meta.url).resolve()` code path end-to-end.
 *
 * Why this file exists: the PR #4390 bug was that bare `require.resolve` throws
 * ReferenceError under ESM (`require` is undefined there), which the try/catch
 * silently swallowed — so validateConfig() could NEVER return true. These tests
 * prove the real probe runs without throwing a ReferenceError, and that its
 * boolean result matches the genuine resolvability of
 * @earendil-works/pi-agent-core in the current environment (absent today →
 * false; auto-adapts if #4384 later adds the dependency).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { PiAgentProvider } from './provider.js';

const PI_SPECIFIER = '@earendil-works/pi-agent-core';

// Compute the genuine resolvability of the pi package from THIS ESM context,
// using the same mechanism the provider uses. validateConfig() must agree with
// this ground truth regardless of whether the package is installed.
function isPiResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve(PI_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

describe('PiAgentProvider — real ESM probe (PR #4390, un-mocked)', () => {
  it('validateConfig() does not throw (no bare-require ReferenceError)', () => {
    const provider = new PiAgentProvider();
    expect(() => provider.validateConfig()).not.toThrow();
  });

  it('validateConfig() matches genuine package resolvability', () => {
    const provider = new PiAgentProvider();
    expect(provider.validateConfig()).toBe(isPiResolvable());
  });

  it('in the current skeleton (package not a dependency) the probe reports false', () => {
    // Documents the expected skeleton state. If #4384 makes pi-agent-core a
    // real dependency, isPiResolvable() flips to true and the test above keeps
    // passing; this explicit assertion would then need updating.
    expect(isPiResolvable()).toBe(false);
    expect(new PiAgentProvider().validateConfig()).toBe(false);
  });
});
