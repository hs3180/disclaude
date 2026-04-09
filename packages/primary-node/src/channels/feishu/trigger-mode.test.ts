import { describe, it, expect } from 'vitest';
import { TriggerModeManager, type TriggerModeRecord } from './trigger-mode.js';

describe('TriggerModeManager', () => {
  describe('basic operations', () => {
    it('should default to mention mode', () => {
      const manager = new TriggerModeManager();
      expect(manager.getTriggerMode('oc_test')).toBe('mention');
    });

    it('should set mode to always for a chat', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_test', 'always');
      expect(manager.getTriggerMode('oc_test')).toBe('always');
    });

    it('should set mode back to mention for a chat', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_test', 'always');
      manager.setTriggerMode('oc_test', 'mention');
      expect(manager.getTriggerMode('oc_test')).toBe('mention');
    });

    it('should track multiple chats independently', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_chat1', 'always');
      manager.setTriggerMode('oc_chat2', 'mention');

      expect(manager.getTriggerMode('oc_chat1')).toBe('always');
      expect(manager.getTriggerMode('oc_chat2')).toBe('mention');
    });

    it('should list all chats with always mode', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_chat1', 'always');
      manager.setTriggerMode('oc_chat2', 'always');
      manager.setTriggerMode('oc_chat3', 'mention');

      const alwaysChats = manager.getAlwaysModeChats();
      expect(alwaysChats).toHaveLength(2);
      expect(alwaysChats).toContain('oc_chat1');
      expect(alwaysChats).toContain('oc_chat2');
      expect(alwaysChats).not.toContain('oc_chat3');
    });
  });

  describe('initFromRecords', () => {
    it('should load records with triggerMode: always', () => {
      const manager = new TriggerModeManager();
      const records: TriggerModeRecord[] = [
        { chatId: 'oc_auto1', triggerMode: 'always' },
        { chatId: 'oc_auto2', triggerMode: 'always' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.getTriggerMode('oc_auto1')).toBe('always');
      expect(manager.getTriggerMode('oc_auto2')).toBe('always');
    });

    it('should not load records with triggerMode: mention', () => {
      const manager = new TriggerModeManager();
      const records: TriggerModeRecord[] = [
        { chatId: 'oc_normal', triggerMode: 'mention' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(0);
      expect(manager.getTriggerMode('oc_normal')).toBe('mention');
    });

    it('should not load records with undefined triggerMode', () => {
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
        { chatId: 'oc_always1', triggerMode: 'always' },
        { chatId: 'oc_mention', triggerMode: 'mention' },
        { chatId: 'oc_default' },
        { chatId: 'oc_always2', triggerMode: 'always' },
      ];

      const loaded = manager.initFromRecords(records);
      expect(loaded).toBe(2);
      expect(manager.getTriggerMode('oc_always1')).toBe('always');
      expect(manager.getTriggerMode('oc_always2')).toBe('always');
      expect(manager.getTriggerMode('oc_mention')).toBe('mention');
      expect(manager.getTriggerMode('oc_default')).toBe('mention');
    });

    it('should handle empty records array', () => {
      const manager = new TriggerModeManager();
      const loaded = manager.initFromRecords([]);
      expect(loaded).toBe(0);
    });

    it('should override manually set mode', () => {
      const manager = new TriggerModeManager();
      manager.setTriggerMode('oc_manual', 'mention');
      manager.initFromRecords([{ chatId: 'oc_manual', triggerMode: 'always' }]);
      expect(manager.getTriggerMode('oc_manual')).toBe('always');
    });
  });
});
