/**
 * P0 Integration Test: InteractiveContextStore multi-card coexistence.
 *
 * Verifies that the InteractiveContextStore correctly handles multiple
 * interactive cards within the same chat — the scenario fixed in #1625.
 *
 * This test exercises the store behavior at an integration level:
 * - Multiple cards registered for the same chatId
 * - Action prompt resolution across cards
 * - Fallback from messageId to chatId lookup
 * - Expiration and cleanup of older cards
 *
 * **Note:** This test does NOT require real Feishu API credentials since it
 * tests the in-memory store behavior. It runs as part of the normal test
 * suite to continuously verify the #1625 fix.
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1625 - IPC sendInteractive actionPrompts overwritten
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InteractiveContextStore } from '../../../interactive-context.js';

describe('InteractiveContextStore: multi-card coexistence (Issue #1625 verification)', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    // Use a short maxAge for expiration tests
    store = new InteractiveContextStore(24 * 60 * 60 * 1000);
  });

  describe('multiple cards in the same chat', () => {
    it('should track action prompts for each card independently', () => {
      // Simulate two different cards sent to the same chat
      store.register('msg-card-A', 'chat-1', {
        explain_ai: '[用户操作] 用户选择了「解释AI」',
        ai_history: '[用户操作] 用户选择了「AI历史」',
      });
      store.register('msg-card-B', 'chat-1', {
        start_task: '[用户操作] 用户选择了「开始任务」',
        cancel: '[用户操作] 用户选择了「取消」',
      });

      // Each card's prompts should be retrievable by exact messageId
      const promptsA = store.getActionPrompts('msg-card-A');
      const promptsB = store.getActionPrompts('msg-card-B');

      expect(promptsA).toBeDefined();
      expect(promptsA?.explain_ai).toBe('[用户操作] 用户选择了「解释AI」');
      expect(promptsA?.start_task).toBeUndefined(); // Card A doesn't have this action

      expect(promptsB).toBeDefined();
      expect(promptsB?.start_task).toBe('[用户操作] 用户选择了「开始任务」');
      expect(promptsB?.explain_ai).toBeUndefined(); // Card B doesn't have this action
    });

    it('should resolve correct prompts via chatId fallback for each card', () => {
      store.register('msg-card-A', 'chat-1', {
        action_a1: 'Card A action 1',
        action_a2: 'Card A action 2',
      });
      store.register('msg-card-B', 'chat-1', {
        action_b1: 'Card B action 1',
        action_b2: 'Card B action 2',
      });

      // chatId-based fallback returns the LATEST card's prompts
      const chatPrompts = store.getActionPromptsByChatId('chat-1');
      expect(chatPrompts).toBeDefined();
      // Should return Card B's prompts (latest registered)
      expect(chatPrompts?.action_b1).toBe('Card B action 1');
    });

    it('should generate correct prompts when messageId matches exactly', () => {
      store.register('msg-card-A', 'chat-1', {
        opt_1: '[用户操作] 用户选择了「选项1」',
      });
      store.register('msg-card-B', 'chat-1', {
        opt_2: '[用户操作] 用户选择了「选项2」',
      });

      // Exact messageId match should always return the correct card's prompts
      const promptA = store.generatePrompt('msg-card-A', 'chat-1', 'opt_1', '选项1');
      expect(promptA).toBe('[用户操作] 用户选择了「选项1」');

      const promptB = store.generatePrompt('msg-card-B', 'chat-1', 'opt_2', '选项2');
      expect(promptB).toBe('[用户操作] 用户选择了「选项2」');
    });

    it('should handle three or more cards in the same chat', () => {
      const cardCount = 5;
      for (let i = 0; i < cardCount; i++) {
        store.register(`msg-card-${i}`, 'chat-1', {
          [`action_${i}`]: `Prompt for card ${i}`,
        });
      }

      expect(store.size).toBe(cardCount);

      // Each card should still be retrievable
      for (let i = 0; i < cardCount; i++) {
        const prompts = store.getActionPrompts(`msg-card-${i}`);
        expect(prompts).toBeDefined();
        expect(prompts?.[`action_${i}`]).toBe(`Prompt for card ${i}`);
      }

      // chatId fallback should return the last card's prompts
      const lastPrompts = store.getActionPromptsByChatId('chat-1');
      expect(lastPrompts?.action_4).toBe('Prompt for card 4');
    });
  });

  describe('card unregistration in multi-card scenario', () => {
    it('should not affect other cards when one is unregistered', () => {
      store.register('msg-card-A', 'chat-1', { action: 'A' });
      store.register('msg-card-B', 'chat-1', { action: 'B' });

      // Unregister Card A
      const removed = store.unregister('msg-card-A');
      expect(removed).toBe(true);

      // Card B should still be accessible
      expect(store.getActionPrompts('msg-card-B')?.action).toBe('B');

      // chatId index should still work
      expect(store.getActionPromptsByChatId('chat-1')?.action).toBe('B');

      // Card A should be gone
      expect(store.getActionPrompts('msg-card-A')).toBeUndefined();
    });

    it('should update chatId index correctly after unregistering latest card', () => {
      store.register('msg-card-A', 'chat-1', { action: 'A' });
      store.register('msg-card-B', 'chat-1', { action: 'B' });
      store.register('msg-card-C', 'chat-1', { action: 'C' });

      // Unregister the latest card (Card C)
      store.unregister('msg-card-C');

      // chatId index should be cleaned up (since it pointed to Card C)
      const chatPrompts = store.getActionPromptsByChatId('chat-1');
      // After unregistering the card that the index pointed to, the index is cleaned
      expect(chatPrompts).toBeUndefined();
    });
  });

  describe('cross-chat isolation', () => {
    it('should not leak action prompts between different chats', () => {
      store.register('msg-1', 'chat-A', { action: 'Chat A action' });
      store.register('msg-2', 'chat-B', { action: 'Chat B action' });

      expect(store.getActionPromptsByChatId('chat-A')?.action).toBe('Chat A action');
      expect(store.getActionPromptsByChatId('chat-B')?.action).toBe('Chat B action');
    });

    it('should handle the same action value in different chats independently', () => {
      store.register('msg-1', 'chat-A', { confirm: 'Confirmed in chat A' });
      store.register('msg-2', 'chat-B', { confirm: 'Confirmed in chat B' });

      const promptA = store.generatePrompt('msg-1', 'chat-A', 'confirm');
      const promptB = store.generatePrompt('msg-2', 'chat-B', 'confirm');

      expect(promptA).toBe('Confirmed in chat A');
      expect(promptB).toBe('Confirmed in chat B');
    });
  });

  describe('expiration in multi-card scenario', () => {
    it('should only clean up expired cards', async () => {
      const shortMaxAge = 100; // 100ms
      const testStore = new InteractiveContextStore(shortMaxAge);

      testStore.register('msg-old', 'chat-1', { action: 'old' });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      testStore.register('msg-new', 'chat-1', { action: 'new' });

      const cleaned = testStore.cleanupExpired();
      expect(cleaned).toBe(1);
      expect(testStore.getActionPrompts('msg-old')).toBeUndefined();
      expect(testStore.getActionPrompts('msg-new')).toBeDefined();
    });
  });
});
