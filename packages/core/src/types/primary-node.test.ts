/**
 * Tests for primary-node types (packages/core/src/types/primary-node.ts)
 *
 * Issue #1617 Phase 2: Tests for node type capabilities and helper functions.
 *
 * Covers:
 * - getNodeCapabilities: primary vs worker node capabilities
 * - Type narrowing behavior
 */

import { describe, it, expect } from 'vitest';
import { getNodeCapabilities } from './primary-node.js';

describe('Primary Node Types', () => {
  // =========================================================================
  // getNodeCapabilities
  // =========================================================================
  describe('getNodeCapabilities', () => {
    it('should return both capabilities for primary node', () => {
      const caps = getNodeCapabilities('primary');
      expect(caps.communication).toBe(true);
      expect(caps.execution).toBe(true);
    });

    it('should return only execution for worker node', () => {
      const caps = getNodeCapabilities('worker');
      expect(caps.communication).toBe(false);
      expect(caps.execution).toBe(true);
    });

    it('should return an object with both boolean fields', () => {
      const caps = getNodeCapabilities('primary');
      expect(caps).toHaveProperty('communication');
      expect(caps).toHaveProperty('execution');
      expect(typeof caps.communication).toBe('boolean');
      expect(typeof caps.execution).toBe('boolean');
    });

    it('should differentiate between primary and worker communication', () => {
      const primaryCaps = getNodeCapabilities('primary');
      const workerCaps = getNodeCapabilities('worker');
      expect(primaryCaps.communication).toBe(true);
      expect(workerCaps.communication).toBe(false);
    });

    it('should always have execution=true for both node types', () => {
      const primaryCaps = getNodeCapabilities('primary');
      const workerCaps = getNodeCapabilities('worker');
      expect(primaryCaps.execution).toBe(true);
      expect(workerCaps.execution).toBe(true);
    });
  });
});
