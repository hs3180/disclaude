/**
 * Unit tests for PassiveModeManager
 *
 * Issue #2069: Declarative passive mode via chat config files.
 */

import { describe, it, expect } from 'vitest';
import { PassiveModeManager } from './passive-mode.js';

describe('PassiveModeManager', () => {
  describe('basic operations', () => {
    it('should default to passive mode enabled (not disabled)', () => {
      const manager = new PassiveModeManager();
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should disable passive mode for a chat', () => {
      const manager = new PassiveModeManager();
      manager.setPassiveModeDisabled('oc_test', true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should re-enable passive mode for a chat', () => {
      const manager = new PassiveModeManager();
      manager.setPassiveModeDisabled('oc_test', true);
      manager.setPassiveModeDisabled('oc_test', false);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should track multiple chats independently', () => {
      const manager = new PassiveModeManager();
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', false);

      expect(manager.isPassiveModeDisabled('oc_chat1')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_chat2')).toBe(false);
    });

    it('should list all chats with passive mode disabled', () => {
      const manager = new PassiveModeManager();
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);
      manager.setPassiveModeDisabled('oc_chat3', false);

      const disabled = manager.getPassiveModeDisabledChats();
      expect(disabled).toHaveLength(2);
      expect(disabled).toContain('oc_chat1');
      expect(disabled).toContain('oc_chat2');
      expect(disabled).not.toContain('oc_chat3');
    });
  });

  describe('initFromRecords (Issue #2069)', () => {
    it('should load records with passiveMode: false', () => {
      const manager = new PassiveModeManager();
      const records = [
        { chatId: 'oc_auto1', passiveMode: false },
        { chatId: 'oc_auto2', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isPassiveModeDisabled('oc_auto1')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_auto2')).toBe(true);
    });

    it('should not load records with passiveMode: true', () => {
      const manager = new PassiveModeManager();
      const records = [
        { chatId: 'oc_normal', passiveMode: true },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      expect(manager.isPassiveModeDisabled('oc_normal')).toBe(false);
    });

    it('should not load records with undefined passiveMode', () => {
      const manager = new PassiveModeManager();
      const records = [
        { chatId: 'oc_default' },
        { chatId: 'oc_undefined', passiveMode: undefined },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
    });

    it('should handle mixed records correctly', () => {
      const manager = new PassiveModeManager();
      const records = [
        { chatId: 'oc_off', passiveMode: false },
        { chatId: 'oc_on', passiveMode: true },
        { chatId: 'oc_default' },
        { chatId: 'oc_off2', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isPassiveModeDisabled('oc_off')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_off2')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_on')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_default')).toBe(false);
    });

    it('should handle empty records array', () => {
      const manager = new PassiveModeManager();
      const loaded = manager.initFromRecords([]);
      expect(loaded).toBe(0);
    });

    it('should not override manually set passive mode', () => {
      const manager = new PassiveModeManager();
      // Manually set passive mode off for a chat
      manager.setPassiveModeDisabled('oc_manual', false);
      // Then init from records with passiveMode: false
      manager.initFromRecords([{ chatId: 'oc_manual', passiveMode: false }]);
      // Should be enabled now (initFromRecords loads false as disabled)
      expect(manager.isPassiveModeDisabled('oc_manual')).toBe(true);
    });
  });
});
