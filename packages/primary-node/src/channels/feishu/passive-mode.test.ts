/**
 * Unit tests for TriggerModeManager (Issue #2193: renamed from PassiveModeManager)
 *
 * Issue #2069: Declarative trigger mode via chat config files.
 * Issue #2052: Auto-enable trigger mode for 2-member group chats.
 * Issue #2193: Renamed from PassiveModeManager.
 */

import { describe, it, expect } from 'vitest';
import { TriggerModeManager } from './passive-mode.js';

describe('TriggerModeManager', () => {
  describe('basic operations', () => {
    it('should default to trigger mode disabled (mention-only)', () => {
      const manager = new TriggerModeManager();
      expect(manager.isTriggerEnabled('oc_test')).toBe(false);
    });

    it('should enable trigger mode for a chat', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_test', true);
      expect(manager.isTriggerEnabled('oc_test')).toBe(true);
    });

    it('should disable trigger mode for a chat', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_test', true);
      manager.setTriggerEnabled('oc_test', false);
      expect(manager.isTriggerEnabled('oc_test')).toBe(false);
    });

    it('should track multiple chats independently', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_chat1', true);
      manager.setTriggerEnabled('oc_chat2', false);

      expect(manager.isTriggerEnabled('oc_chat1')).toBe(true);
      expect(manager.isTriggerEnabled('oc_chat2')).toBe(false);
    });

    it('should list all chats with trigger mode enabled', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_chat1', true);
      manager.setTriggerEnabled('oc_chat2', true);
      manager.setTriggerEnabled('oc_chat3', false);

      const enabled = manager.getTriggerEnabledChats();
      expect(enabled).toHaveLength(2);
      expect(enabled).toContain('oc_chat1');
      expect(enabled).toContain('oc_chat2');
      expect(enabled).not.toContain('oc_chat3');
    });
  });

  describe('initFromRecords (Issue #2069)', () => {
    it('should load records with passiveMode: false as trigger mode enabled', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_auto1', passiveMode: false },
        { chatId: 'oc_auto2', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isTriggerEnabled('oc_auto1')).toBe(true);
      expect(manager.isTriggerEnabled('oc_auto2')).toBe(true);
    });

    it('should not load records with passiveMode: true', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_normal', passiveMode: true },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      expect(manager.isTriggerEnabled('oc_normal')).toBe(false);
    });

    it('should not load records with undefined passiveMode', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_default' },
        { chatId: 'oc_undefined', passiveMode: undefined },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
    });

    it('should handle mixed records correctly', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_off', passiveMode: false },
        { chatId: 'oc_on', passiveMode: true },
        { chatId: 'oc_default' },
        { chatId: 'oc_off2', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isTriggerEnabled('oc_off')).toBe(true);
      expect(manager.isTriggerEnabled('oc_off2')).toBe(true);
      expect(manager.isTriggerEnabled('oc_on')).toBe(false);
      expect(manager.isTriggerEnabled('oc_default')).toBe(false);
    });

    it('should handle empty records array', () => {
      const manager = new TriggerModeManager();
      const loaded = manager.initFromRecords([]);
      expect(loaded).toBe(0);
    });

    it('should override manually set trigger mode', () => {
      const manager = new TriggerModeManager();
      // Manually disable trigger mode for a chat
      manager.setTriggerEnabled('oc_manual', false);
      // Then init from records with passiveMode: false (= trigger mode enabled)
      manager.initFromRecords([{ chatId: 'oc_manual', passiveMode: false }]);
      // Should be enabled now
      expect(manager.isTriggerEnabled('oc_manual')).toBe(true);
    });
  });

  describe('small group auto-detection (Issue #2052)', () => {
    it('should not be a small group by default', () => {
      const manager = new TriggerModeManager();
      expect(manager.isSmallGroup('oc_test')).toBe(false);
    });

    it('should mark a chat as small group', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      expect(manager.isSmallGroup('oc_small')).toBe(true);
    });

    it('should auto-enable trigger mode for small groups', () => {
      const manager = new TriggerModeManager();
      expect(manager.isTriggerEnabled('oc_small')).toBe(false);
      manager.markAsSmallGroup('oc_small');
      expect(manager.isTriggerEnabled('oc_small')).toBe(true);
    });

    it('should not mark the same chat twice', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      manager.markAsSmallGroup('oc_small');
      // getTriggerEnabledChats should not have duplicates
      const enabled = manager.getTriggerEnabledChats();
      const count = enabled.filter((id) => id === 'oc_small').length;
      expect(count).toBe(1);
    });

    it('should include small groups in getTriggerEnabledChats', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_manual', true);
      manager.markAsSmallGroup('oc_small');

      const enabled = manager.getTriggerEnabledChats();
      expect(enabled).toContain('oc_manual');
      expect(enabled).toContain('oc_small');
      expect(enabled).toHaveLength(2);
    });

    it('should deduplicate when chat is both manually enabled and small group', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_both', true);
      manager.markAsSmallGroup('oc_both');

      const enabled = manager.getTriggerEnabledChats();
      const count = enabled.filter((id) => id === 'oc_both').length;
      expect(count).toBe(1);
    });

    it('should keep trigger mode enabled for small group even when manually disabled', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      // User tries to disable trigger mode via /trigger off
      manager.setTriggerEnabled('oc_small', false);
      // Small group status persists — trigger mode stays enabled
      expect(manager.isTriggerEnabled('oc_small')).toBe(true);
      expect(manager.isSmallGroup('oc_small')).toBe(true);
    });
  });
});
