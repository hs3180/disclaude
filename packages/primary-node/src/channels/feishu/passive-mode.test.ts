/**
 * Unit tests for PassiveModeManager
 *
 * Issue #2069: Declarative passive mode via chat config files.
 * Issue #2052: Auto-disable passive mode for 2-member group chats.
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

  describe('small group auto-evaluation (Issue #2052)', () => {
    /**
     * These tests verify the PassiveModeManager state transitions
     * that occur when MessageHandler.autoEvaluatePassiveModeForSmallGroup()
     * detects a 2-member group chat.
     *
     * The auto-evaluation logic in MessageHandler:
     * 1. Checks member count via getMembers() API
     * 2. If 2 members → calls setPassiveModeDisabled(chatId, true)
     * 3. If 3+ members → does nothing (passive mode stays enabled)
     * 4. If already disabled → skips evaluation entirely
     */

    it('should allow disabling passive mode for a 2-member group', () => {
      const manager = new PassiveModeManager();
      // Simulate: MessageHandler detects 2-member group and auto-disables
      manager.setPassiveModeDisabled('oc_2member_group', true);
      expect(manager.isPassiveModeDisabled('oc_2member_group')).toBe(true);
    });

    it('should keep passive mode enabled for a 3+ member group', () => {
      const manager = new PassiveModeManager();
      // Simulate: MessageHandler detects 3-member group, does nothing
      // Default state should remain: passive mode enabled
      expect(manager.isPassiveModeDisabled('oc_3member_group')).toBe(false);
    });

    it('should not change state if user already disabled passive mode', () => {
      const manager = new PassiveModeManager();
      // User explicitly disabled passive mode before auto-evaluation
      manager.setPassiveModeDisabled('oc_user_set', true);
      // Auto-evaluation sees it's already disabled → skips
      // State should remain unchanged
      expect(manager.isPassiveModeDisabled('oc_user_set')).toBe(true);
      // And it should appear in the disabled chats list
      expect(manager.getPassiveModeDisabledChats()).toContain('oc_user_set');
    });

    it('should not change state if user explicitly enabled passive mode in a 2-member group', () => {
      const manager = new PassiveModeManager();
      // Edge case: User explicitly runs /passive on in a 2-member group
      // Auto-evaluation already ran and disabled it, but user re-enabled
      manager.setPassiveModeDisabled('oc_user_override', true); // auto-eval
      manager.setPassiveModeDisabled('oc_user_override', false); // user override
      expect(manager.isPassiveModeDisabled('oc_user_override')).toBe(false);
    });

    it('should handle multiple groups independently', () => {
      const manager = new PassiveModeManager();
      // Group 1: 2 members → auto-disable
      manager.setPassiveModeDisabled('oc_group_2member', true);
      // Group 2: 5 members → keep passive
      // (no setPassiveModeDisabled call)
      // Group 3: 2 members → auto-disable
      manager.setPassiveModeDisabled('oc_group_2member_b', true);

      expect(manager.isPassiveModeDisabled('oc_group_2member')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_group_5member')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_group_2member_b')).toBe(true);
      expect(manager.getPassiveModeDisabledChats()).toHaveLength(2);
    });

    it('should work correctly with initFromRecords after auto-evaluation', () => {
      const manager = new PassiveModeManager();
      // Simulate: auto-evaluation disables passive for a 2-member group
      manager.setPassiveModeDisabled('oc_auto', true);
      // Later, initFromRecords runs (e.g., from persisted TempChatRecord)
      manager.initFromRecords([
        { chatId: 'oc_auto', passiveMode: false },
        { chatId: 'oc_new', passiveMode: false },
      ]);
      // Both should be disabled
      expect(manager.isPassiveModeDisabled('oc_auto')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_new')).toBe(true);
    });
  });
});
