/**
 * Tests for DebugGroupService.
 *
 * @see Issue #487
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DebugGroupService, getDebugGroupService } from './debug-group-service.js';

describe('DebugGroupService', () => {
  let service: DebugGroupService;

  beforeEach(() => {
    // Create a fresh instance for each test
    service = new DebugGroupService();
  });

  describe('setDebugGroup', () => {
    it('should set the debug group', () => {
      const previous = service.setDebugGroup('oc_test123', 'Test Group');

      expect(previous).toBeNull();

      const current = service.getDebugGroup();
      expect(current).not.toBeNull();
      expect(current?.chatId).toBe('oc_test123');
      expect(current?.name).toBe('Test Group');
      expect(current?.setAt).toBeGreaterThan(0);
    });

    it('should return previous group when overwriting', () => {
      service.setDebugGroup('oc_first', 'First Group');
      const previous = service.setDebugGroup('oc_second', 'Second Group');

      expect(previous).not.toBeNull();
      expect(previous?.chatId).toBe('oc_first');
      expect(previous?.name).toBe('First Group');

      const current = service.getDebugGroup();
      expect(current?.chatId).toBe('oc_second');
    });

    it('should work without a name', () => {
      const previous = service.setDebugGroup('oc_noname');

      expect(previous).toBeNull();

      const current = service.getDebugGroup();
      expect(current?.chatId).toBe('oc_noname');
      expect(current?.name).toBeUndefined();
    });
  });

  describe('getDebugGroup', () => {
    it('should return null when no group is set', () => {
      expect(service.getDebugGroup()).toBeNull();
    });

    it('should return the current debug group', () => {
      service.setDebugGroup('oc_current', 'Current Group');

      const current = service.getDebugGroup();
      expect(current?.chatId).toBe('oc_current');
      expect(current?.name).toBe('Current Group');
    });
  });

  describe('clearDebugGroup', () => {
    it('should return null when no group is set', () => {
      const previous = service.clearDebugGroup();
      expect(previous).toBeNull();
    });

    it('should clear the debug group and return previous', () => {
      service.setDebugGroup('oc_to_clear', 'To Clear');

      const previous = service.clearDebugGroup();
      expect(previous?.chatId).toBe('oc_to_clear');
      expect(service.getDebugGroup()).toBeNull();
    });
  });

  describe('isDebugGroup', () => {
    it('should return false when no group is set', () => {
      expect(service.isDebugGroup('oc_any')).toBe(false);
    });

    it('should return true for the debug group chat ID', () => {
      service.setDebugGroup('oc_debug');

      expect(service.isDebugGroup('oc_debug')).toBe(true);
      expect(service.isDebugGroup('oc_other')).toBe(false);
    });
  });
});

describe('getDebugGroupService', () => {
  it('should return a singleton instance', () => {
    const instance1 = getDebugGroupService();
    const instance2 = getDebugGroupService();

    expect(instance1).toBe(instance2);
  });
});
