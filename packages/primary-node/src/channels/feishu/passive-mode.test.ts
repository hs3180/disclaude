/**
 * Tests for PassiveModeManager.
 *
 * Issue #2052: Auto-disable passive mode for 2-member group chats
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PassiveModeManager } from './passive-mode.js';

describe('PassiveModeManager', () => {
  let manager: PassiveModeManager;

  beforeEach(() => {
    manager = new PassiveModeManager();
  });

  describe('basic passive mode', () => {
    it('should default to passive mode enabled (not disabled)', () => {
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should disable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('oc_test', true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should re-enable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('oc_test', true);
      manager.setPassiveModeDisabled('oc_test', false);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should return all chats with passive mode disabled', () => {
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);

      const chats = manager.getPassiveModeDisabledChats();
      expect(chats).toContain('oc_chat1');
      expect(chats).toContain('oc_chat2');
      expect(chats).toHaveLength(2);
    });
  });

  describe('small-group detection (Issue #2052)', () => {
    it('should not be checked by default', () => {
      expect(manager.isSmallGroupChecked('oc_test')).toBe(false);
    });

    it('should mark a chat as checked', () => {
      manager.markSmallGroupChecked('oc_test');
      expect(manager.isSmallGroupChecked('oc_test')).toBe(true);
    });

    it('should auto-disable passive mode for 2-member group', () => {
      const result = manager.handleSmallGroupDetection('oc_test', 2);

      expect(result).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
      expect(manager.isSmallGroupChecked('oc_test')).toBe(true);
    });

    it('should auto-disable passive mode for 1-member group (edge case)', () => {
      const result = manager.handleSmallGroupDetection('oc_test', 1);

      expect(result).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should NOT auto-disable passive mode for 3+ member group', () => {
      const result = manager.handleSmallGroupDetection('oc_test', 3);

      expect(result).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
      expect(manager.isSmallGroupChecked('oc_test')).toBe(true);
    });

    it('should NOT auto-disable passive mode for large group', () => {
      const result = manager.handleSmallGroupDetection('oc_test', 10);

      expect(result).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should mark as checked even for large groups', () => {
      manager.handleSmallGroupDetection('oc_test', 50);
      expect(manager.isSmallGroupChecked('oc_test')).toBe(true);
    });

    it('should not overwrite existing passive mode setting', () => {
      // User explicitly enabled passive mode (re-enabled it)
      manager.setPassiveModeDisabled('oc_test', true);
      manager.setPassiveModeDisabled('oc_test', false);

      // Small group detection should auto-disable it again
      const result = manager.handleSmallGroupDetection('oc_test', 2);
      expect(result).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should not re-disable if already disabled (no-op)', () => {
      manager.setPassiveModeDisabled('oc_test', true);

      // Should still return true (is small group) but not log duplicate
      const result = manager.handleSmallGroupDetection('oc_test', 2);
      expect(result).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should handle multiple chats independently', () => {
      manager.handleSmallGroupDetection('oc_small', 2);
      manager.handleSmallGroupDetection('oc_large', 5);

      expect(manager.isPassiveModeDisabled('oc_small')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_large')).toBe(false);
      expect(manager.isSmallGroupChecked('oc_small')).toBe(true);
      expect(manager.isSmallGroupChecked('oc_large')).toBe(true);
    });
  });
});
