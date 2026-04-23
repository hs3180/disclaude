/**
 * Tests for worker-node types (packages/core/src/types/worker-node.ts)
 *
 * Issue #1617 Phase 2: Tests for worker node capability helper.
 *
 * Covers:
 * - getWorkerNodeCapabilities: returns correct capabilities
 * - Capability invariant: worker never has communication
 */

import { describe, it, expect } from 'vitest';
import { getWorkerNodeCapabilities } from './worker-node.js';

describe('Worker Node Types', () => {
  // =========================================================================
  // getWorkerNodeCapabilities
  // =========================================================================
  describe('getWorkerNodeCapabilities', () => {
    it('should return communication=false', () => {
      const caps = getWorkerNodeCapabilities();
      expect(caps.communication).toBe(false);
    });

    it('should return execution=true', () => {
      const caps = getWorkerNodeCapabilities();
      expect(caps.execution).toBe(true);
    });

    it('should consistently return the same capabilities', () => {
      const caps1 = getWorkerNodeCapabilities();
      const caps2 = getWorkerNodeCapabilities();
      expect(caps1).toEqual(caps2);
    });

    it('should return an object with both boolean fields', () => {
      const caps = getWorkerNodeCapabilities();
      expect(caps).toHaveProperty('communication');
      expect(caps).toHaveProperty('execution');
      expect(typeof caps.communication).toBe('boolean');
      expect(typeof caps.execution).toBe('boolean');
    });
  });
});
