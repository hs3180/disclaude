/**
 * Unit tests for Primary Node type definitions.
 *
 * Issue #4291: the Worker Node package was removed in #2964, so `NodeType`
 * was narrowed from `'primary' | 'worker'` to `'primary'`. This test locks
 * that narrowing in so it cannot silently regress. The `getNodeCapabilities`
 * helper had no callers and was dropped in the same cleanup.
 */

import { describe, it, expect } from 'vitest';

describe('NodeType (Issue #4291 cleanup)', () => {
  it('NodeType is narrowed to primary only — "worker" is no longer assignable', () => {
    // Regression guard: the assignment below only type-errors while NodeType's
    // sole member is 'primary'. If the union is ever widened back to include
    // 'worker', the error disappears and @ts-expect-error itself then fails the
    // type-check ("Unused '@ts-expect-error' directive"), turning the build red.
    // The runtime expect merely confirms the assignment executed.
    // @ts-expect-error 'worker' is not assignable to NodeType ('primary')
    const worker: import('./primary-node.js').NodeType = 'worker';
    expect(worker).toBe('worker');
  });
});
