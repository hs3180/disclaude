/**
 * Tests for PassiveModeManager.
 *
 * Issue #2018: Verify explicit setting detection for temp chat auto-disable.
 */

import { describe, it, expect } from 'vitest';
import { PassiveModeManager } from './passive-mode.js';

describe('PassiveModeManager', () => {
  describe('basic behavior', () => {
    it('should return false by default (passive mode enabled)', () => {
      const mgr = new PassiveModeManager();
      expect(mgr.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should return true when passive mode is disabled', () => {
      const mgr = new PassiveModeManager();
      mgr.setPassiveModeDisabled('oc_test', true);
      expect(mgr.isPassiveModeDisabled('oc_test')).toBe(true);
    });
  });

  describe('hasExplicitSetting (Issue #2018)', () => {
    it('should return false when no setting exists', () => {
      const mgr = new PassiveModeManager();
      expect(mgr.hasExplicitSetting('oc_test')).toBe(false);
    });

    it('should return true after disabling passive mode', () => {
      const mgr = new PassiveModeManager();
      mgr.setPassiveModeDisabled('oc_test', true);
      expect(mgr.hasExplicitSetting('oc_test')).toBe(true);
    });

    it('should return true after enabling passive mode (explicitly)', () => {
      const mgr = new PassiveModeManager();
      mgr.setPassiveModeDisabled('oc_test', false);
      expect(mgr.hasExplicitSetting('oc_test')).toBe(true);
      expect(mgr.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should not affect other chat IDs', () => {
      const mgr = new PassiveModeManager();
      mgr.setPassiveModeDisabled('oc_test1', true);
      expect(mgr.hasExplicitSetting('oc_test1')).toBe(true);
      expect(mgr.hasExplicitSetting('oc_test2')).toBe(false);
    });
  });

  describe('temp chat scenario (Issue #2018)', () => {
    it('should allow caller to distinguish default from explicit passive-on', () => {
      const mgr = new PassiveModeManager();
      const chatId = 'oc_temp_chat';

      // Before any explicit setting: no explicit setting → caller should check temp chat
      expect(mgr.hasExplicitSetting(chatId)).toBe(false);
      expect(mgr.isPassiveModeDisabled(chatId)).toBe(false);

      // User runs /passive on → explicit passive mode enabled
      mgr.setPassiveModeDisabled(chatId, false);
      expect(mgr.hasExplicitSetting(chatId)).toBe(true);
      expect(mgr.isPassiveModeDisabled(chatId)).toBe(false);

      // User runs /passive off → explicit passive mode disabled
      mgr.setPassiveModeDisabled(chatId, true);
      expect(mgr.hasExplicitSetting(chatId)).toBe(true);
      expect(mgr.isPassiveModeDisabled(chatId)).toBe(true);
    });
  });

  describe('getPassiveModeDisabledChats', () => {
    it('should only return chats with passive mode disabled (true)', () => {
      const mgr = new PassiveModeManager();
      mgr.setPassiveModeDisabled('oc_disabled', true);
      mgr.setPassiveModeDisabled('oc_enabled', false);
      mgr.setPassiveModeDisabled('oc_disabled2', true);

      const chats = mgr.getPassiveModeDisabledChats();
      expect(chats).toContain('oc_disabled');
      expect(chats).toContain('oc_disabled2');
      expect(chats).not.toContain('oc_enabled');
    });

    it('should return empty array when no chats are disabled', () => {
      const mgr = new PassiveModeManager();
      expect(mgr.getPassiveModeDisabledChats()).toEqual([]);
    });
  });
});
