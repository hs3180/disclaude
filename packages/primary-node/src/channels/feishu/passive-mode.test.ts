/**
 * Unit tests for TriggerModeManager (Issue #2193: renamed from PassiveModeManager)
 *
 * Issue #2069: Declarative trigger mode via chat config files.
 * Issue #2052: Auto-enable trigger mode for 2-member group chats.
 * Issue #2193: Renamed from PassiveModeManager.
 * Issue #3345: Added 'auto' mode for intelligent group size detection.
 */

import { describe, it, expect } from 'vitest';
import { TriggerModeManager } from './passive-mode.js';

describe('TriggerModeManager', () => {
  describe('default mode', () => {
    it('should default to "auto" mode', () => {
      const manager = new TriggerModeManager();
      expect(manager.getMode('oc_test')).toBe('auto');
    });

    it('should not be trigger-enabled in auto mode without small group detection', () => {
      const manager = new TriggerModeManager();
      expect(manager.isTriggerEnabled('oc_test')).toBe(false);
    });
  });

  describe('getMode / setMode (Issue #3345)', () => {
    it('should set and get auto mode', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'auto');
      expect(manager.getMode('oc_test')).toBe('auto');
    });

    it('should set and get mention mode', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'mention');
      expect(manager.getMode('oc_test')).toBe('mention');
    });

    it('should set and get always mode', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'always');
      expect(manager.getMode('oc_test')).toBe('always');
    });

    it('should override a previously set mode', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'always');
      expect(manager.getMode('oc_test')).toBe('always');
      manager.setMode('oc_test', 'mention');
      expect(manager.getMode('oc_test')).toBe('mention');
    });
  });

  describe('isTriggerEnabled with auto mode (Issue #3345)', () => {
    it('should not be enabled in auto mode without small group detection', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'auto');
      expect(manager.isTriggerEnabled('oc_test')).toBe(false);
    });

    it('should be enabled in auto mode after small group detection', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'auto');
      manager.markAsSmallGroup('oc_test');
      expect(manager.isTriggerEnabled('oc_test')).toBe(true);
    });

    it('should always be enabled in always mode regardless of small group status', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'always');
      expect(manager.isTriggerEnabled('oc_test')).toBe(true);
      expect(manager.isSmallGroup('oc_test')).toBe(false);
    });

    it('should never be enabled in mention mode regardless of small group status', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_test', 'mention');
      manager.markAsSmallGroup('oc_test');
      expect(manager.isTriggerEnabled('oc_test')).toBe(false);
    });

    it('should be enabled by default (auto) after small group detection', () => {
      const manager = new TriggerModeManager();
      // Default mode is 'auto' — no explicit setMode call needed
      manager.markAsSmallGroup('oc_test');
      expect(manager.isTriggerEnabled('oc_test')).toBe(true);
    });
  });

  describe('legacy setTriggerEnabled (backward compat)', () => {
    it('should enable trigger mode (maps to always)', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_test', true);
      expect(manager.getMode('oc_test')).toBe('always');
      expect(manager.isTriggerEnabled('oc_test')).toBe(true);
    });

    it('should disable trigger mode (maps to mention)', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_test', true);
      manager.setTriggerEnabled('oc_test', false);
      expect(manager.getMode('oc_test')).toBe('mention');
      expect(manager.isTriggerEnabled('oc_test')).toBe(false);
    });

    it('should track multiple chats independently', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerEnabled('oc_chat1', true);
      manager.setTriggerEnabled('oc_chat2', false);

      expect(manager.isTriggerEnabled('oc_chat1')).toBe(true);
      expect(manager.isTriggerEnabled('oc_chat2')).toBe(false);
    });
  });

  describe('getTriggerEnabledChats', () => {
    it('should list all chats with trigger mode enabled', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_chat1', 'always');
      manager.setMode('oc_chat2', 'mention');
      manager.setMode('oc_chat3', 'auto');

      const enabled = manager.getTriggerEnabledChats();
      expect(enabled).toHaveLength(1);
      expect(enabled).toContain('oc_chat1');
    });

    it('should include auto-mode small groups', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_chat1', 'auto');
      manager.markAsSmallGroup('oc_chat1');

      const enabled = manager.getTriggerEnabledChats();
      expect(enabled).toContain('oc_chat1');
    });

    it('should deduplicate when chat is both explicitly enabled and small group', () => {
      const manager = new TriggerModeManager();
      manager.setMode('oc_both', 'always');
      manager.markAsSmallGroup('oc_both');

      const enabled = manager.getTriggerEnabledChats();
      const count = enabled.filter((id) => id === 'oc_both').length;
      expect(count).toBe(1);
    });
  });

  describe('initFromRecords (Issue #2069, #2291, #3345)', () => {
    it('should load records with passiveMode: false as "always"', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_auto1', passiveMode: false },
        { chatId: 'oc_auto2', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.getMode('oc_auto1')).toBe('always');
      expect(manager.getMode('oc_auto2')).toBe('always');
    });

    it('should load records with triggerMode: "always"', () => {
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

    it('should load records with triggerMode: "auto"', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_auto1', triggerMode: 'auto' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.getMode('oc_auto1')).toBe('auto');
      // Auto mode without small group detection → not enabled
      expect(manager.isTriggerEnabled('oc_auto1')).toBe(false);
    });

    it('should not load records with triggerMode: "mention"', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_mention', triggerMode: 'mention' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.getMode('oc_mention')).toBe('mention');
    });

    it('should prefer triggerMode over passiveMode', () => {
      const manager = new TriggerModeManager();
      const records = [
        // triggerMode: always takes precedence, even though passiveMode: true
        { chatId: 'oc_conflict1', triggerMode: 'always' as const, passiveMode: true },
        // triggerMode: mention takes precedence, even though passiveMode: false
        { chatId: 'oc_conflict2', triggerMode: 'mention' as const, passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isTriggerEnabled('oc_conflict1')).toBe(true);
      expect(manager.isTriggerEnabled('oc_conflict2')).toBe(false);
    });

    it('should not load records with passiveMode: true', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_normal', passiveMode: true },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.getMode('oc_normal')).toBe('mention');
    });

    it('should skip records with undefined passiveMode and no triggerMode (gets default auto)', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_default' },
        { chatId: 'oc_undefined', passiveMode: undefined },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      // Falls back to default 'auto'
      expect(manager.getMode('oc_default')).toBe('auto');
    });

    it('should handle mixed records correctly', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_off', passiveMode: false },
        { chatId: 'oc_on', passiveMode: true },
        { chatId: 'oc_default' },
        { chatId: 'oc_enum_always', triggerMode: 'always' as const },
        { chatId: 'oc_enum_mention', triggerMode: 'mention' as const },
        { chatId: 'oc_enum_auto', triggerMode: 'auto' as const },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(5);
      expect(manager.isTriggerEnabled('oc_off')).toBe(true);
      expect(manager.isTriggerEnabled('oc_enum_always')).toBe(true);
      expect(manager.isTriggerEnabled('oc_on')).toBe(false);
      expect(manager.isTriggerEnabled('oc_default')).toBe(false);
      expect(manager.isTriggerEnabled('oc_enum_mention')).toBe(false);
      expect(manager.isTriggerEnabled('oc_enum_auto')).toBe(false);
    });

    it('should handle empty records array', () => {
      const manager = new TriggerModeManager();
      const loaded = manager.initFromRecords([]);
      expect(loaded).toBe(0);
    });

    it('should override manually set trigger mode', () => {
      const manager = new TriggerModeManager();
      // Manually set to mention
      manager.setMode('oc_manual', 'mention');
      // Then init from records with triggerMode: 'always'
      manager.initFromRecords([{ chatId: 'oc_manual', triggerMode: 'always' as const }]);
      // Should be always now
      expect(manager.getMode('oc_manual')).toBe('always');
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

    it('should auto-enable trigger mode for small groups in auto mode', () => {
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
      manager.setMode('oc_manual', 'always');
      manager.markAsSmallGroup('oc_small');

      const enabled = manager.getTriggerEnabledChats();
      expect(enabled).toContain('oc_manual');
      expect(enabled).toContain('oc_small');
      expect(enabled).toHaveLength(2);
    });

    it('should keep trigger enabled for small group in auto mode even when setMode("auto") is called', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      manager.setMode('oc_small', 'auto');
      // Small group status persists — trigger mode stays enabled in auto mode
      expect(manager.isTriggerEnabled('oc_small')).toBe(true);
      expect(manager.isSmallGroup('oc_small')).toBe(true);
    });

    it('should NOT enable trigger for small group in mention mode', () => {
      const manager = new TriggerModeManager();
      manager.markAsSmallGroup('oc_small');
      manager.setMode('oc_small', 'mention');
      // mention mode overrides auto-detection — trigger stays disabled
      expect(manager.isTriggerEnabled('oc_small')).toBe(false);
      expect(manager.isSmallGroup('oc_small')).toBe(true);
    });
  });
});
