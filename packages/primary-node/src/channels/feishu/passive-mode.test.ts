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

  describe('initFromRecords (Issue #2069, #2291)', () => {
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

    it('should load records with triggerMode: "always" (Issue #2291)', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_enum1', triggerMode: 'always' as const },
        { chatId: 'oc_enum2', triggerMode: 'always' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isTriggerEnabled('oc_enum1')).toBe(true);
      expect(manager.isTriggerEnabled('oc_enum2')).toBe(true);
    });

    it('should not load records with triggerMode: "mention"', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_mention', triggerMode: 'mention' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      expect(manager.isTriggerEnabled('oc_mention')).toBe(false);
    });

    it('should prefer triggerMode over passiveMode (Issue #2291)', () => {
      const manager = new TriggerModeManager();
      const records = [
        // triggerMode: always takes precedence, even though passiveMode: true
        { chatId: 'oc_conflict1', triggerMode: 'always' as const, passiveMode: true },
        // triggerMode: mention takes precedence, even though passiveMode: false
        { chatId: 'oc_conflict2', triggerMode: 'mention' as const, passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.isTriggerEnabled('oc_conflict1')).toBe(true);
      expect(manager.isTriggerEnabled('oc_conflict2')).toBe(false);
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
        { chatId: 'oc_enum_always', triggerMode: 'always' as const },
        { chatId: 'oc_enum_mention', triggerMode: 'mention' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isTriggerEnabled('oc_off')).toBe(true);
      expect(manager.isTriggerEnabled('oc_enum_always')).toBe(true);
      expect(manager.isTriggerEnabled('oc_on')).toBe(false);
      expect(manager.isTriggerEnabled('oc_default')).toBe(false);
      expect(manager.isTriggerEnabled('oc_enum_mention')).toBe(false);
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
      // Then init from records with triggerMode: 'always'
      manager.initFromRecords([{ chatId: 'oc_manual', triggerMode: 'always' as const }]);
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

  describe('auto mode (Issue #3345)', () => {
    it('should default to auto mode for unknown chats', () => {
      const manager = new TriggerModeManager();
      expect(manager.getMode('oc_new')).toBe('auto');
    });

    it('should not trigger in auto mode for non-small groups', () => {
      const manager = new TriggerModeManager();
      expect(manager.isTriggerEnabled('oc_new')).toBe(false);
    });

    it('should trigger in auto mode when marked as small group', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      expect(manager.isTriggerEnabled('oc_small')).toBe(true);
    });

    it('should not trigger in mention mode even for small groups', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      manager.setMode('oc_small', 'mention');
      expect(manager.isTriggerEnabled('oc_small')).toBe(false);
    });

    it('should always trigger in always mode regardless of group size', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_large', 'always');
      expect(manager.isTriggerEnabled('oc_large')).toBe(true);
    });

    it('should support setMode with auto value', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_chat', 'auto');
      expect(manager.getMode('oc_chat')).toBe('auto');
    });

    it('should support getMode with enum-based interface', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_always', 'always');
      manager.setMode('oc_mention', 'mention');
      manager.setMode('oc_auto', 'auto');

      expect(manager.getMode('oc_always')).toBe('always');
      expect(manager.getMode('oc_mention')).toBe('mention');
      expect(manager.getMode('oc_auto')).toBe('auto');
    });

    it('should load auto mode from records without force-enabling', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_auto', triggerMode: 'auto' as const },
      ];

      const loaded = manager.initFromRecords(records);
      // auto mode should not count as force-enabled
      expect(loaded).toBe(0);
      // But mode should be stored
      expect(manager.getMode('oc_auto')).toBe('auto');
      // Not enabled because not a small group
      expect(manager.isTriggerEnabled('oc_auto')).toBe(false);
    });

    it('should load old records without triggerMode as auto default', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_old' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      // Default is auto
      expect(manager.getMode('oc_old')).toBe('auto');
    });

    it('should still load always mode records as force-enabled', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_always', triggerMode: 'always' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.isTriggerEnabled('oc_always')).toBe(true);
    });

    it('should still load legacy passiveMode:false as force-enabled', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_legacy', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.isTriggerEnabled('oc_legacy')).toBe(true);
    });

    it('should include always-mode chats in getTriggerEnabledChats', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_always', 'always');
      manager.setMode('oc_mention', 'mention');
      manager.setMode('oc_auto', 'auto');

      const enabled = manager.getTriggerEnabledChats();
      expect(enabled).toContain('oc_always');
      expect(enabled).not.toContain('oc_mention');
      expect(enabled).not.toContain('oc_auto');
    });
  });
});
