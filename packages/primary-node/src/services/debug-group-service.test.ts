/**
 * Tests for DebugGroupService.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

import {
  DebugGroupService,
  getDebugGroupService,
  resetDebugGroupService,
} from './debug-group-service.js';

describe('DebugGroupService', () => {
  let service: DebugGroupService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDebugGroupService();
    service = new DebugGroupService();
  });

  describe('setDebugGroup', () => {
    it('should set the debug group and return null for first call', () => {
      const result = service.setDebugGroup('oc_test123', 'Test Group');

      expect(result).toBeNull();
      expect(service.getDebugGroup()).toEqual({
        chatId: 'oc_test123',
        name: 'Test Group',
        setAt: expect.any(Number),
      });
    });

    it('should set the debug group without name', () => {
      service.setDebugGroup('oc_test456');

      expect(service.getDebugGroup()).toEqual({
        chatId: 'oc_test456',
        name: undefined,
        setAt: expect.any(Number),
      });
    });

    it('should return previous debug group when setting a new one', () => {
      service.setDebugGroup('oc_first', 'First Group');

      const previous = service.setDebugGroup('oc_second', 'Second Group');

      expect(previous).toEqual({
        chatId: 'oc_first',
        name: 'First Group',
        setAt: expect.any(Number),
      });
      expect(service.getDebugGroup()?.chatId).toBe('oc_second');
    });

    it('should set setAt to current timestamp', () => {
      const before = Date.now();
      service.setDebugGroup('oc_time');
      const after = Date.now();

      const setAt = service.getDebugGroup()!.setAt;
      expect(setAt).toBeGreaterThanOrEqual(before);
      expect(setAt).toBeLessThanOrEqual(after);
    });
  });

  describe('getDebugGroup', () => {
    it('should return null when no debug group is set', () => {
      expect(service.getDebugGroup()).toBeNull();
    });

    it('should return the current debug group info', () => {
      service.setDebugGroup('oc_abc', 'ABC Group');
      const info = service.getDebugGroup();

      expect(info).not.toBeNull();
      expect(info!.chatId).toBe('oc_abc');
      expect(info!.name).toBe('ABC Group');
      expect(info!.setAt).toBeTypeOf('number');
    });
  });

  describe('clearDebugGroup', () => {
    it('should clear the debug group and return null when none set', () => {
      const result = service.clearDebugGroup();
      expect(result).toBeNull();
    });

    it('should clear the debug group and return previous', () => {
      service.setDebugGroup('oc_clear', 'Clear Me');
      const previous = service.clearDebugGroup();

      expect(previous).not.toBeNull();
      expect(previous!.chatId).toBe('oc_clear');
      expect(service.getDebugGroup()).toBeNull();
    });

    it('should allow setting a new group after clearing', () => {
      service.setDebugGroup('oc_first');
      service.clearDebugGroup();
      service.setDebugGroup('oc_second');

      expect(service.getDebugGroup()?.chatId).toBe('oc_second');
    });
  });

  describe('isDebugGroup', () => {
    it('should return false when no debug group is set', () => {
      expect(service.isDebugGroup('oc_any')).toBe(false);
    });

    it('should return true for the current debug group chat ID', () => {
      service.setDebugGroup('oc_debug');
      expect(service.isDebugGroup('oc_debug')).toBe(true);
    });

    it('should return false for a different chat ID', () => {
      service.setDebugGroup('oc_debug');
      expect(service.isDebugGroup('oc_other')).toBe(false);
    });

    it('should return false after clearing', () => {
      service.setDebugGroup('oc_debug');
      service.clearDebugGroup();
      expect(service.isDebugGroup('oc_debug')).toBe(false);
    });
  });

  describe('singleton', () => {
    it('should return the same instance from getDebugGroupService', () => {
      const instance1 = getDebugGroupService();
      const instance2 = getDebugGroupService();

      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after reset', () => {
      const instance1 = getDebugGroupService();
      resetDebugGroupService();
      const instance2 = getDebugGroupService();

      expect(instance1).not.toBe(instance2);
    });

    it('should preserve state across singleton calls', () => {
      const instance = getDebugGroupService();
      instance.setDebugGroup('oc_singleton');
      expect(getDebugGroupService().isDebugGroup('oc_singleton')).toBe(true);
    });

    it('should lose state after reset', () => {
      const instance = getDebugGroupService();
      instance.setDebugGroup('oc_reset_test');
      resetDebugGroupService();
      expect(getDebugGroupService().isDebugGroup('oc_reset_test')).toBe(false);
    });
  });
});
