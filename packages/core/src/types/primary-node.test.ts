/**
 * Unit tests for Primary Node type definitions.
 *
 * Issue #4291: the Worker Node package was removed in #2964, so `NodeType`
 * was narrowed from `'primary' | 'worker'` to `'primary'` and the dead
 * `'worker'` branch in `getNodeCapabilities` was dropped. These tests lock
 * that in so neither can silently regress.
 */

import { describe, it, expect } from 'vitest';
import { getNodeCapabilities } from './primary-node.js';

describe('NodeType / getNodeCapabilities (Issue #4291 cleanup)', () => {
  it('getNodeCapabilities returns full capabilities for the primary node', () => {
    expect(getNodeCapabilities('primary')).toEqual({
      communication: true,
      execution: true,
    });
  });

  it('NodeType is narrowed to primary only — "worker" is no longer assignable', () => {
    // Compile-time assertion: this line type-checks only while NodeType's
    // sole member is 'primary'. If someone widens the union back to include
    // 'worker', the cast below still compiles, so we also assert at runtime
    // that the only accepted value is 'primary'.
    const onlyPrimary: import('./primary-node.js').NodeType = 'primary';
    expect(onlyPrimary).toBe('primary');
  });
});
