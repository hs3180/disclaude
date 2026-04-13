/**
 * Tests for DebugGroupService.
 *
 * @see debug-group-service.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DebugGroupService,
  getDebugGroupService,
  resetDebugGroupService,
} from './debug-group-service.js';

describe('DebugGroupService', () => {
  let service: DebugGroupService;

  beforeEach(() => {
    service = new DebugGroupService();
    resetDebugGroupService();
  });

  afterEach(() => {
    resetDebugGroupService();
  });

  describe('setDebugGroup', () => {
    it('should set debug group with chatId', () => {
      const result = service.setDebugGroup('oc_123');
      expect(result).toBeNull();
      expect(service.getDebugGroup()).toMatchObject({
        chatId: 'oc_123',
        setAt: expect.any(Number),
      });
    });

    it('should set debug group with chatId and name', () => {
      service.setDebugGroup('oc_123', 'Debug Room');
      expect(service.getDebugGroup()).toMatchObject({
        chatId: 'oc_123',
        name: 'Debug Room',
        setAt: expect.any(Number),
      });
    });

    it('should return previous debug group when overwriting', () => {
      service.setDebugGroup('oc_old', 'Old Room');
      const previous = service.setDebugGroup('oc_new', 'New Room');

      expect(previous).toMatchObject({
        chatId: 'oc_old',
        name: 'Old Room',
      });
      expect(service.getDebugGroup()?.chatId).toBe('oc_new');
    });

    it('should record setAt timestamp', () => {
      const before = Date.now();
      service.setDebugGroup('oc_123');
      const after = Date.now();

      const {setAt} = (service.getDebugGroup()!);
      expect(setAt).toBeGreaterThanOrEqual(before);
      expect(setAt).toBeLessThanOrEqual(after);
    });

    it('should return null when no previous debug group was set', () => {
      const result = service.setDebugGroup('oc_first');
      expect(result).toBeNull();
    });
  });

  describe('getDebugGroup', () => {
    it('should return null when no debug group is set', () => {
      expect(service.getDebugGroup()).toBeNull();
    });

    it('should return the current debug group info', () => {
      service.setDebugGroup('oc_abc', 'Test Group');
      const info = service.getDebugGroup();

      expect(info).toEqual({
        chatId: 'oc_abc',
        name: 'Test Group',
        setAt: expect.any(Number),
      });
    });
  });

  describe('clearDebugGroup', () => {
    it('should clear the debug group', () => {
      service.setDebugGroup('oc_123');
      service.clearDebugGroup();
      expect(service.getDebugGroup()).toBeNull();
    });

    it('should return previous debug group when clearing', () => {
      service.setDebugGroup('oc_123', 'My Group');
      const previous = service.clearDebugGroup();

      expect(previous).toMatchObject({
        chatId: 'oc_123',
        name: 'My Group',
      });
    });

    it('should return null when clearing with no debug group set', () => {
      const previous = service.clearDebugGroup();
      expect(previous).toBeNull();
    });

    it('should be safe to call clear multiple times', () => {
      service.setDebugGroup('oc_123');
      service.clearDebugGroup();
      const secondClear = service.clearDebugGroup();
      expect(secondClear).toBeNull();
    });
  });

  describe('isDebugGroup', () => {
    it('should return true when chatId matches the debug group', () => {
      service.setDebugGroup('oc_target');
      expect(service.isDebugGroup('oc_target')).toBe(true);
    });

    it('should return false when chatId does not match', () => {
      service.setDebugGroup('oc_target');
      expect(service.isDebugGroup('oc_other')).toBe(false);
    });

    it('should return false when no debug group is set', () => {
      expect(service.isDebugGroup('oc_any')).toBe(false);
    });

    it('should update after changing debug group', () => {
      service.setDebugGroup('oc_first');
      expect(service.isDebugGroup('oc_first')).toBe(true);
      expect(service.isDebugGroup('oc_second')).toBe(false);

      service.setDebugGroup('oc_second');
      expect(service.isDebugGroup('oc_first')).toBe(false);
      expect(service.isDebugGroup('oc_second')).toBe(true);
    });

    it('should return false after clearing', () => {
      service.setDebugGroup('oc_target');
      service.clearDebugGroup();
      expect(service.isDebugGroup('oc_target')).toBe(false);
    });
  });

  describe('singleton helpers', () => {
    it('getDebugGroupService should return same instance', () => {
      const instance1 = getDebugGroupService();
      const instance2 = getDebugGroupService();
      expect(instance1).toBe(instance2);
    });

    it('resetDebugGroupService should create new instance on next get', () => {
      const instance1 = getDebugGroupService();
      resetDebugGroupService();
      const instance2 = getDebugGroupService();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('edge cases', () => {
    it('should handle set → clear → set cycle', () => {
      service.setDebugGroup('oc_first', 'First');
      service.clearDebugGroup();
      service.setDebugGroup('oc_second', 'Second');

      expect(service.getDebugGroup()?.chatId).toBe('oc_second');
      expect(service.getDebugGroup()?.name).toBe('Second');
      expect(service.isDebugGroup('oc_first')).toBe(false);
      expect(service.isDebugGroup('oc_second')).toBe(true);
    });

    it('should handle setting without name', () => {
      service.setDebugGroup('oc_noname');
      const info = service.getDebugGroup();
      expect(info?.chatId).toBe('oc_noname');
      expect(info?.name).toBeUndefined();
    });
  });
});
