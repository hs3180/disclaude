/**
 * Unit tests for TriggerModeManager
 *
 * Issue #2193: Refactor passive mode to trigger mode (mention / always).
 */

import { describe, it, expect } from 'vitest';
import { TriggerModeManager, type TriggerModeRecord } from './trigger-mode.js';

describe('TriggerModeManager', () => {
  describe('basic operations', () => {
    it('should default trigger mode to mention (isAlwaysMode returns false)', () => {
      const manager = new TriggerModeManager();
      expect(manager.isAlwaysMode('oc_test')).toBe(false);
    });

    it('should set trigger mode to always for a chat', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_test', 'always');
      expect(manager.isAlwaysMode('oc_test')).toBe(true);
    });

    it('should set trigger mode back to mention and remove the override', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_test', 'always');
      manager.setTriggerMode('oc_test', 'mention');
      expect(manager.isAlwaysMode('oc_test')).toBe(false);
    });

    it('should track multiple chats independently', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_chat1', 'always');
      manager.setTriggerMode('oc_chat2', 'mention');

      expect(manager.isAlwaysMode('oc_chat1')).toBe(true);
      expect(manager.isAlwaysMode('oc_chat2')).toBe(false);
    });

    it('should only return chats with non-default mode from getTriggerModeOverrideChats', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_chat1', 'always');
      manager.setTriggerMode('oc_chat2', 'always');
      manager.setTriggerMode('oc_chat3', 'mention');

      const overrides = manager.getTriggerModeOverrideChats();
      expect(overrides).toHaveLength(2);
      expect(overrides).toContain('oc_chat1');
      expect(overrides).toContain('oc_chat2');
      expect(overrides).not.toContain('oc_chat3');
    });
  });

  describe('initFromRecords (Issue #2193)', () => {
    it('should load records with triggerMode: always', () => {
      const manager = new TriggerModeManager();
      const records: TriggerModeRecord[] = [
        { chatId: 'oc_auto1', triggerMode: 'always' },
        { chatId: 'oc_auto2', triggerMode: 'always' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isAlwaysMode('oc_auto1')).toBe(true);
      expect(manager.isAlwaysMode('oc_auto2')).toBe(true);
    });

    it('should skip records with triggerMode: mention', () => {
      const manager = new TriggerModeManager();
      const records: TriggerModeRecord[] = [
        { chatId: 'oc_normal', triggerMode: 'mention' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      expect(manager.isAlwaysMode('oc_normal')).toBe(false);
    });

    it('should skip records with undefined triggerMode', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_default' },
        { chatId: 'oc_undefined', triggerMode: undefined },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
    });

    it('should handle mixed records correctly', () => {
      const manager = new TriggerModeManager();
      const records: TriggerModeRecord[] = [
        { chatId: 'oc_always', triggerMode: 'always' },
        { chatId: 'oc_mention', triggerMode: 'mention' },
        { chatId: 'oc_default' },
        { chatId: 'oc_always2', triggerMode: 'always' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.isAlwaysMode('oc_always')).toBe(true);
      expect(manager.isAlwaysMode('oc_always2')).toBe(true);
      expect(manager.isAlwaysMode('oc_mention')).toBe(false);
      expect(manager.isAlwaysMode('oc_default')).toBe(false);
    });

    it('should handle backward compat: passiveMode: false maps to always', () => {
      const manager = new TriggerModeManager();
      const records = [
        { chatId: 'oc_legacy', passiveMode: false },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(1);
      expect(manager.isAlwaysMode('oc_legacy')).toBe(true);
    });

    it('should set trigger mode to mention and remove the override', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_test', 'always');
      manager.setTriggerMode('oc_test', 'mention');
      expect(manager.isAlwaysMode('oc_test')).toBe(false);

      const overrides = manager.getTriggerModeOverrideChats();
      expect(overrides).not.toContain('oc_test');
    });
  });
});
