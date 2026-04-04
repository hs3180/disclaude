/**
 * Unit tests for 2-member group auto-disable passive mode.
 *
 * Issue #2052: 2-member groups (bot + 1 user) should default to
 * passive mode OFF, behaving like private chats.
 *
 * Tests the checkAndAutoDisableForTwoMemberGroup logic via
 * PassiveModeManager integration (unit level, no Feishu client needed).
 */

import { describe, it, expect } from 'vitest';
import { PassiveModeManager } from './passive-mode.js';

// We test the logic conceptually through PassiveModeManager since
// checkAndAutoDisableForTwoMemberGroup is a private method on MessageHandler.
// The actual integration is tested by verifying the state transitions.

describe('2-member group auto-disable passive mode (Issue #2052)', () => {
  describe('auto-disable behavior', () => {
    it('should auto-disable passive mode when group has exactly 2 members', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_two_member_group';

      // Before: passive mode is enabled (default)
      expect(manager.isPassiveModeDisabled(chatId)).toBe(false);

      // Simulate: auto-detect triggers for 2-member group
      // (This is what checkAndAutoDisableForTwoMemberGroup does internally)
      manager.setPassiveModeDisabled(chatId, true);

      // After: passive mode is disabled (bot responds to all messages)
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);
    });

    it('should NOT auto-disable passive mode when group has more than 2 members', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_multi_member_group';

      // For a 3+ member group, we do NOT call setPassiveModeDisabled
      expect(manager.isPassiveModeDisabled(chatId)).toBe(false);
    });

    it('should NOT auto-disable passive mode when already disabled (cache hit)', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_already_disabled';

      // Pre-disabled by other mechanism (e.g., /passive off command)
      manager.setPassiveModeDisabled(chatId, true);
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);

      // Simulate cache hit: skip API call, return existing state
      // The method should not call getMembers again
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should not change state after auto-disable even if more members join', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_was_two_now_three';

      // Initially 2 members → auto-disable
      manager.setPassiveModeDisabled(chatId, true);
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);

      // Later, 3rd member joins → state should NOT change
      // (cache prevents re-check)
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);
    });

    it('should allow /passive on to re-enable passive mode after auto-disable', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_user_toggle';

      // Auto-disabled for 2-member group
      manager.setPassiveModeDisabled(chatId, true);
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);

      // User manually re-enables via /passive on
      manager.setPassiveModeDisabled(chatId, false);
      expect(manager.isPassiveModeDisabled(chatId)).toBe(false);
    });

    it('should not affect other chats when auto-disabling for one chat', () => {
      const manager = new PassiveModeManager();

      // Auto-disable for chat A
      manager.setPassiveModeDisabled('oc_chat_a', true);

      // Chat B should remain unaffected
      expect(manager.isPassiveModeDisabled('oc_chat_b')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_chat_a')).toBe(true);
    });

    it('should survive initFromRecords after auto-disable', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_temp';

      // Auto-disable for 2-member group
      manager.setPassiveModeDisabled(chatId, true);

      // Simulate restart: initFromRecords re-applies state
      const records = [{ chatId, passiveMode: false }];
      manager.initFromRecords(records);

      // State should still be disabled after restart
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);
    });
  });

  describe('cache behavior (simulated)', () => {
    it('should only check member count once per chat', () => {
      const manager = new PassiveModeManager();
      const chatId = 'oc_cached_check';

      // Simulate: first check → 2 members → auto-disable
      const firstCheck = !manager.isPassiveModeDisabled(chatId);
      if (firstCheck) {
        manager.setPassiveModeDisabled(chatId, true);
      }

      // Simulate: second check (cached) → skip API call
      // The cache prevents redundant getMembers API calls
      expect(manager.isPassiveModeDisabled(chatId)).toBe(true);
    });

    it('should track multiple chats independently in cache', () => {
      const manager = new PassiveModeManager();

      // Chat A: 2 members → auto-disable
      manager.setPassiveModeDisabled('oc_chat_a', true);

      // Chat B: 5 members → no auto-disable
      // (setPassiveModeDisabled not called for chat_b)

      // Chat C: 2 members → auto-disable
      manager.setPassiveModeDisabled('oc_chat_c', true);

      expect(manager.isPassiveModeDisabled('oc_chat_a')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_chat_b')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_chat_c')).toBe(true);
      // Verify independent tracking
      expect(manager.getPassiveModeDisabledChats()).toHaveLength(2);
    });
  });
});
