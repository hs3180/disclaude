/**
 * Integration Test: InteractiveContextStore multi-card coexistence.
 *
 * Verifies that multiple interactive cards can coexist in the same chat
 * without action prompt conflicts. Tests the fix from Issue #1625.
 *
 * This test is gated by FEISHU_INTEGRATION_TEST env var.
 * When not set, all tests are automatically skipped.
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 * @see Issue #1625 — IPC sendInteractive actionPrompts overwrite fix
 * @see Issue #1572 — InteractiveContextStore migration to Primary Node
 */

import { it, expect, beforeEach } from 'vitest';
import { describeIfFeishu } from './helpers.js';
import { InteractiveContextStore } from '../../../interactive-context.js';

describeIfFeishu('InteractiveContextStore — multi-card coexistence', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  // -----------------------------------------------------------------------
  // Core: chatId index tracks latest card only
  // -----------------------------------------------------------------------

  it('should allow multiple cards in the same chat without data loss', () => {
    const chatId = 'oc_multi_card_chat';

    // Card 1: "Choose language" card
    store.register('msg_card1_en', chatId, {
      lang_en: '[用户操作] 用户选择了 English',
      lang_zh: '[用户操作] 用户选择了 中文',
    });

    // Card 2: "Confirm action" card (sent later)
    store.register('msg_card2_confirm', chatId, {
      yes: '[用户操作] 用户确认了操作',
      no: '[用户操作] 用户取消了操作',
    });

    // Both cards should exist independently
    expect(store.size).toBe(2);
    expect(store.getActionPrompts('msg_card1_en')).toEqual({
      lang_en: '[用户操作] 用户选择了 English',
      lang_zh: '[用户操作] 用户选择了 中文',
    });
    expect(store.getActionPrompts('msg_card2_confirm')).toEqual({
      yes: '[用户操作] 用户确认了操作',
      no: '[用户操作] 用户取消了操作',
    });
  });

  it('should resolve the latest card via chatId fallback', () => {
    const chatId = 'oc_fallback_chat';

    store.register('msg_old', chatId, { a: 'Old prompt A' });
    store.register('msg_new', chatId, { b: 'New prompt B' });

    // chatId fallback returns the latest card
    expect(store.getActionPromptsByChatId(chatId)).toEqual({ b: 'New prompt B' });
  });

  // -----------------------------------------------------------------------
  // Scenario: Sequential card actions in the same chat
  // -----------------------------------------------------------------------

  it('should handle sequential card interactions in the same chat', () => {
    const chatId = 'oc_sequential_chat';

    // Step 1: Bot sends "Choose language" card
    store.register('msg_lang_1', chatId, {
      en: 'User selected English',
      zh: 'User selected Chinese',
    });

    // Step 2: User clicks "English" (exact messageId match)
    const prompt1 = store.generatePrompt('msg_lang_1', chatId, 'en', 'English');
    expect(prompt1).toBe('User selected English');

    // Step 3: Bot sends "Confirm settings" card
    store.register('msg_confirm_1', chatId, {
      ok: 'User confirmed settings',
      redo: 'User wants to redo',
    });

    // Step 4: User clicks "OK" on confirm card (exact messageId match)
    const prompt2 = store.generatePrompt('msg_confirm_1', chatId, 'ok', 'OK');
    expect(prompt2).toBe('User confirmed settings');

    // Step 5: If Feishu sends back a different messageId, fallback to chatId
    const prompt3 = store.generatePrompt('om_unknown_id', chatId, 'ok', 'OK');
    expect(prompt3).toBe('User confirmed settings'); // Falls back to latest card
  });

  // -----------------------------------------------------------------------
  // Scenario: Card lifecycle (register → interact → unregister)
  // -----------------------------------------------------------------------

  it('should handle card lifecycle: register → interact → unregister', () => {
    const chatId = 'oc_lifecycle_chat';
    const cardId = 'msg_lifecycle';

    // Register
    store.register(cardId, chatId, { action: 'User clicked' });
    expect(store.size).toBe(1);

    // Interact
    const prompt = store.generatePrompt(cardId, chatId, 'action', 'Click');
    expect(prompt).toBe('User clicked');

    // Unregister (e.g., after action is processed)
    const removed = store.unregister(cardId);
    expect(removed).toBe(true);
    expect(store.size).toBe(0);
    expect(store.getActionPrompts(cardId)).toBeUndefined();
  });

  it('should not affect other cards when one is unregistered', () => {
    const chatId = 'oc_cleanup_chat';

    store.register('msg_keep', chatId, { keep: 'Keep this' });
    store.register('msg_remove', chatId, { remove: 'Remove this' });

    store.unregister('msg_remove');

    expect(store.size).toBe(1);
    expect(store.getActionPrompts('msg_keep')).toEqual({ keep: 'Keep this' });
    // chatId index is cleaned up when the latest card is removed,
    // but the remaining card is still accessible by exact messageId
    expect(store.getActionPrompts('msg_keep')).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('should handle rapid sequential card registrations', () => {
    const chatId = 'oc_rapid_chat';

    for (let i = 0; i < 100; i++) {
      store.register(`msg_rapid_${i}`, chatId, {
        action: `Prompt for card ${i}`,
      });
    }

    expect(store.size).toBe(100);

    // Only the latest card should be accessible via chatId fallback
    const latestPrompts = store.getActionPromptsByChatId(chatId);
    expect(latestPrompts).toEqual({ action: 'Prompt for card 99' });

    // But all cards should still be accessible by exact messageId
    expect(store.getActionPrompts('msg_rapid_0')).toEqual({ action: 'Prompt for card 0' });
    expect(store.getActionPrompts('msg_rapid_99')).toEqual({ action: 'Prompt for card 99' });
  });

  it('should handle cards across different chats independently', () => {
    store.register('msg_chat_a', 'oc_chat_a', { x: 'Chat A prompt' });
    store.register('msg_chat_b', 'oc_chat_b', { x: 'Chat B prompt' });

    expect(store.getActionPromptsByChatId('oc_chat_a')).toEqual({ x: 'Chat A prompt' });
    expect(store.getActionPromptsByChatId('oc_chat_b')).toEqual({ x: 'Chat B prompt' });

    // Unregistering from chat A should not affect chat B
    store.unregister('msg_chat_a');
    expect(store.getActionPromptsByChatId('oc_chat_a')).toBeUndefined();
    expect(store.getActionPromptsByChatId('oc_chat_b')).toEqual({ x: 'Chat B prompt' });
  });

  it('should clean up expired contexts without affecting valid ones', async () => {
    const shortLivedStore = new InteractiveContextStore(100); // 100ms max age
    const chatId = 'oc_expiry_chat';

    // Register an "old" card
    shortLivedStore.register('msg_old', chatId, { old: 'Old prompt' });

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Register a "new" card
    shortLivedStore.register('msg_new', chatId, { new: 'New prompt' });

    // Cleanup should remove only the expired card
    const cleaned = shortLivedStore.cleanupExpired();
    expect(cleaned).toBe(1);
    expect(shortLivedStore.size).toBe(1);
    expect(shortLivedStore.getActionPrompts('msg_new')).toEqual({ new: 'New prompt' });
    expect(shortLivedStore.getActionPrompts('msg_old')).toBeUndefined();
  });
});
