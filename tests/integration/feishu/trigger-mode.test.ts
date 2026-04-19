/**
 * P3 Integration test: Trigger mode (passive mode) behavior.
 *
 * Tests the TriggerModeManager in an IPC-like environment, verifying that:
 * - Default trigger mode (mention-only) works correctly
 * - Trigger mode can be enabled/disabled per chat
 * - Small group auto-detection works
 * - Initialization from persisted records works
 * - Legacy passiveMode records are handled correctly
 *
 * These tests verify the logic layer that determines whether incoming messages
 * should be processed or filtered based on trigger mode state.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #511 — Group chat passive mode control
 * @see Issue #2193 — Renamed from PassiveModeManager to TriggerModeManager
 * @see Issue #2291 — triggerMode enum parameter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerModeManager, type TriggerModeRecord } from '@disclaude/primary-node';
import { describeIfFeishu } from './helpers.js';

describeIfFeishu('Trigger mode (passive mode) behavior', () => {
  let manager: TriggerModeManager;

  beforeEach(() => {
    manager = new TriggerModeManager();
  });

  // ============================================================================
  // Default behavior
  // ============================================================================

  it('should have trigger mode disabled by default for any chat', () => {
    expect(manager.isTriggerEnabled('oc_new_chat')).toBe(false);
    expect(manager.isTriggerEnabled('oc_another_chat')).toBe(false);
  });

  it('should return empty array when no chats have trigger mode enabled', () => {
    expect(manager.getTriggerEnabledChats()).toEqual([]);
  });

  // ============================================================================
  // Enable/disable trigger mode
  // ============================================================================

  it('should enable trigger mode for a specific chat', () => {
    manager.setTriggerEnabled('oc_chat_a', true);

    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(false);
  });

  it('should disable trigger mode for a specific chat', () => {
    manager.setTriggerEnabled('oc_chat_a', true);
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);

    manager.setTriggerEnabled('oc_chat_a', false);
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(false);
  });

  it('should track multiple chats independently', () => {
    manager.setTriggerEnabled('oc_chat_a', true);
    manager.setTriggerEnabled('oc_chat_b', true);
    manager.setTriggerEnabled('oc_chat_c', false);

    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_c')).toBe(false);
    expect(manager.isTriggerEnabled('oc_chat_d')).toBe(false);
  });

  it('should return all enabled chats from getTriggerEnabledChats()', () => {
    manager.setTriggerEnabled('oc_chat_a', true);
    manager.setTriggerEnabled('oc_chat_b', true);

    const enabled = manager.getTriggerEnabledChats();
    expect(enabled).toHaveLength(2);
    expect(enabled).toContain('oc_chat_a');
    expect(enabled).toContain('oc_chat_b');
  });

  // ============================================================================
  // Small group auto-detection (Issue #2052)
  // ============================================================================

  it('should auto-enable trigger mode for small groups', () => {
    manager.markAsSmallGroup('oc_small_group');

    expect(manager.isTriggerEnabled('oc_small_group')).toBe(true);
    expect(manager.isSmallGroup('oc_small_group')).toBe(true);
  });

  it('should keep small group trigger mode even if more members join later', () => {
    manager.markAsSmallGroup('oc_small_group');
    // Even if we try to disable, small group flag keeps it enabled
    manager.setTriggerEnabled('oc_small_group', false);

    // Small group takes precedence — trigger mode stays enabled
    expect(manager.isTriggerEnabled('oc_small_group')).toBe(true);
    expect(manager.isSmallGroup('oc_small_group')).toBe(true);
  });

  it('should include small groups in getTriggerEnabledChats()', () => {
    manager.setTriggerEnabled('oc_manual_chat', true);
    manager.markAsSmallGroup('oc_auto_group');

    const enabled = manager.getTriggerEnabledChats();
    expect(enabled).toHaveLength(2);
    expect(enabled).toContain('oc_manual_chat');
    expect(enabled).toContain('oc_auto_group');
  });

  it('should not duplicate chat if both manually enabled and small group', () => {
    manager.setTriggerEnabled('oc_chat', true);
    manager.markAsSmallGroup('oc_chat');

    const enabled = manager.getTriggerEnabledChats();
    expect(enabled).toHaveLength(1);
  });

  // ============================================================================
  // Initialization from persisted records (Issue #2069)
  // ============================================================================

  it('should initialize from records with triggerMode enum', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_chat_a', triggerMode: 'always' },
      { chatId: 'oc_chat_b', triggerMode: 'mention' },
      { chatId: 'oc_chat_c' }, // no triggerMode specified
    ];

    const loaded = manager.initFromRecords(records);

    expect(loaded).toBe(1);
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(false);
    expect(manager.isTriggerEnabled('oc_chat_c')).toBe(false);
  });

  it('should initialize from records with legacy passiveMode boolean', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_chat_a', passiveMode: false }, // passiveMode: false → trigger enabled
      { chatId: 'oc_chat_b', passiveMode: true },  // passiveMode: true → trigger disabled
    ];

    const loaded = manager.initFromRecords(records);

    expect(loaded).toBe(1);
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(false);
  });

  it('should prefer triggerMode over legacy passiveMode when both present', () => {
    const records: TriggerModeRecord[] = [
      // triggerMode='always' wins over passiveMode=true
      { chatId: 'oc_chat_a', triggerMode: 'always', passiveMode: true },
      // triggerMode='mention' wins over passiveMode=false
      { chatId: 'oc_chat_b', triggerMode: 'mention', passiveMode: false },
    ];

    const loaded = manager.initFromRecords(records);

    expect(loaded).toBe(1); // only oc_chat_a
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(false);
  });

  it('should return 0 when no records enable trigger mode', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_chat_a', triggerMode: 'mention' },
      { chatId: 'oc_chat_b' },
    ];

    const loaded = manager.initFromRecords(records);
    expect(loaded).toBe(0);
    expect(manager.getTriggerEnabledChats()).toEqual([]);
  });

  it('should handle empty records array', () => {
    const loaded = manager.initFromRecords([]);
    expect(loaded).toBe(0);
  });

  it('should accumulate state when initFromRecords called multiple times', () => {
    manager.initFromRecords([
      { chatId: 'oc_chat_a', triggerMode: 'always' },
    ]);
    manager.initFromRecords([
      { chatId: 'oc_chat_b', triggerMode: 'always' },
    ]);

    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(true);
    expect(manager.getTriggerEnabledChats()).toHaveLength(2);
  });

  // ============================================================================
  // Combined scenarios: temp chat + trigger mode (Issue #2291)
  // ============================================================================

  it('should simulate temp chat with trigger mode always', async () => {
    // Simulate: A temp chat is created with triggerMode='always'
    const record: TriggerModeRecord = {
      chatId: 'oc_temp_chat',
      triggerMode: 'always',
    };

    manager.initFromRecords([record]);

    // Bot should respond to all messages in this temp chat
    expect(manager.isTriggerEnabled('oc_temp_chat')).toBe(true);

    // After temp chat is cleaned up, trigger mode should be clearable
    manager.setTriggerEnabled('oc_temp_chat', false);
    // But only if it's not a small group
    expect(manager.isSmallGroup('oc_temp_chat')).toBe(false);
    expect(manager.isTriggerEnabled('oc_temp_chat')).toBe(false);
  });

  it('should simulate temp chat with trigger mode mention (default)', () => {
    // Simulate: A temp chat is created with triggerMode='mention'
    const record: TriggerModeRecord = {
      chatId: 'oc_temp_mention_chat',
      triggerMode: 'mention',
    };

    manager.initFromRecords([record]);

    // Bot should only respond to @mentions in this chat
    expect(manager.isTriggerEnabled('oc_temp_mention_chat')).toBe(false);
  });

  it('should handle mixed scenario: manual + auto + persisted', () => {
    // Manually enable one chat
    manager.setTriggerEnabled('oc_manual', true);

    // Auto-detect a small group
    manager.markAsSmallGroup('oc_small');

    // Load from persisted records
    manager.initFromRecords([
      { chatId: 'oc_persisted', triggerMode: 'always' },
    ]);

    const enabled = manager.getTriggerEnabledChats();
    expect(enabled).toHaveLength(3);
    expect(enabled).toContain('oc_manual');
    expect(enabled).toContain('oc_small');
    expect(enabled).toContain('oc_persisted');

    // Verify individual states
    expect(manager.isTriggerEnabled('oc_manual')).toBe(true);
    expect(manager.isTriggerEnabled('oc_small')).toBe(true);
    expect(manager.isTriggerEnabled('oc_persisted')).toBe(true);
    expect(manager.isTriggerEnabled('oc_unknown')).toBe(false);
  });
});
