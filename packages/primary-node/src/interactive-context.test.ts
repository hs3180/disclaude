/**
 * Tests for InteractiveContextStore.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
 * Extended for multi-card coexistence fix (#1625).
 */

import { describe, it, beforeEach, expect } from 'vitest';
import { InteractiveContextStore } from './interactive-context.js';

describe('InteractiveContextStore', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  describe('register', () => {
    it('should register action prompts for a message', () => {
      store.register('msg-1', 'chat-1', {
        confirm: 'User clicked confirm',
        cancel: 'User clicked cancel',
      });

      const prompts = store.getActionPrompts('msg-1');
      expect(prompts).toEqual({
        confirm: 'User clicked confirm',
        cancel: 'User clicked cancel',
      });
    });

    it('should overwrite existing prompts for the same messageId', () => {
      store.register('msg-1', 'chat-1', { action1: 'prompt1' });
      store.register('msg-1', 'chat-2', { action2: 'prompt2' });

      const prompts = store.getActionPrompts('msg-1');
      expect(prompts).toEqual({ action2: 'prompt2' });
      expect(store.size).toBe(1);
    });

    it('should keep multiple contexts for the same chatId (multi-card coexistence)', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Card A prompt' });
      store.register('msg-2', 'chat-1', { action_b: 'Card B prompt' });

      // Both contexts should exist
      expect(store.getActionPrompts('msg-1')).toEqual({ action_a: 'Card A prompt' });
      expect(store.getActionPrompts('msg-2')).toEqual({ action_b: 'Card B prompt' });
      expect(store.size).toBe(2);
    });

    it('should update chatId index when registering', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should point to the latest messageId (without actionValue)
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should move messageId to end of LRU array on re-register (dedup)', () => {
      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });
      store.register('msg-3', 'chat-1', { c: 'C' });
      // Re-register msg-1 — it should move to the end
      store.register('msg-1', 'chat-1', { a: 'A updated' });

      // All three should still exist
      expect(store.getActionPrompts('msg-1')).toEqual({ a: 'A updated' });
      expect(store.getActionPrompts('msg-2')).toEqual({ b: 'B' });
      expect(store.getActionPrompts('msg-3')).toEqual({ c: 'C' });
      expect(store.size).toBe(3);
    });
  });

  describe('getActionPrompts', () => {
    it('should return undefined for non-existent messageId', () => {
      expect(store.getActionPrompts('non-existent')).toBeUndefined();
    });

    it('should return action prompts for registered messageId', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK prompt' });
      expect(store.getActionPrompts('msg-1')).toEqual({ ok: 'OK prompt' });
    });
  });

  describe('getActionPromptsByChatId', () => {
    it('should return prompts for the latest context in a chat', () => {
      store.register('msg-1', 'chat-1', { old: 'Old prompt' });
      store.register('msg-2', 'chat-1', { new: 'New prompt' });

      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ new: 'New prompt' });
    });

    it('should return undefined for non-existent chatId', () => {
      expect(store.getActionPromptsByChatId('non-existent')).toBeUndefined();
    });

    it('should clean up stale index entries', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.unregister('msg-1');

      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
    });

    it('should search by actionValue across multiple cards (#1625)', () => {
      // Card A sent via IPC script with actions: explain_ai, ai_applications
      store.register('msg-card-a', 'chat-1', {
        explain_ai: '[用户操作] 用户想了解 AI 解释',
        ai_applications: '[用户操作] 用户想了解 AI 应用',
      });

      // Card B sent by Agent with actions: confirm, cancel
      store.register('msg-card-b', 'chat-1', {
        confirm: '[用户操作] 用户确认了操作',
        cancel: '[用户操作] 用户取消了操作',
      });

      // Looking up by actionValue should find the correct card
      expect(store.getActionPromptsByChatId('chat-1', 'explain_ai')).toEqual({
        explain_ai: '[用户操作] 用户想了解 AI 解释',
        ai_applications: '[用户操作] 用户想了解 AI 应用',
      });

      expect(store.getActionPromptsByChatId('chat-1', 'confirm')).toEqual({
        confirm: '[用户操作] 用户确认了操作',
        cancel: '[用户操作] 用户取消了操作',
      });
    });

    it('should prefer newer card when multiple cards have the same actionValue', () => {
      store.register('msg-old', 'chat-1', { ok: 'Old card OK' });
      store.register('msg-new', 'chat-1', { ok: 'New card OK' });

      // Should find the newer card
      expect(store.getActionPromptsByChatId('chat-1', 'ok')).toEqual({ ok: 'New card OK' });
    });

    it('should return undefined when actionValue not found in any card', () => {
      store.register('msg-a', 'chat-1', { action_a: 'A' });
      store.register('msg-b', 'chat-1', { action_b: 'B' });

      expect(store.getActionPromptsByChatId('chat-1', 'non_existent')).toBeUndefined();
    });

    it('should return most recent when actionValue is not provided', () => {
      store.register('msg-a', 'chat-1', { a: 'A' });
      store.register('msg-b', 'chat-1', { b: 'B' });

      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ b: 'B' });
    });
  });

  describe('generatePrompt', () => {
    beforeEach(() => {
      store.register('msg-1', 'chat-1', {
        confirm: '[用户操作] 用户选择了「{{actionText}}」',
        reject: '[用户操作] 用户拒绝了 {{actionValue}}',
        with_type: 'Type: {{actionType}}, Value: {{actionValue}}',
        with_form: 'Name: {{form.name}}, Age: {{form.age}}',
      });
    });

    it('should generate prompt from template using exact messageId', () => {
      const prompt = store.generatePrompt('msg-1', 'chat-1', 'confirm', '确认');
      expect(prompt).toBe('[用户操作] 用户选择了「确认」');
    });

    it('should fall back to chatId-based lookup when messageId does not match', () => {
      // Simulate Feishu callback with real messageId that differs from synthetic
      const prompt = store.generatePrompt('real_feishu_msg_id', 'chat-1', 'confirm', '确认');
      expect(prompt).toBe('[用户操作] 用户选择了「确认」');
    });

    it('should replace {{actionValue}} placeholder', () => {
      const prompt = store.generatePrompt('msg-1', 'chat-1', 'reject');
      expect(prompt).toBe('[用户操作] 用户拒绝了 reject');
    });

    it('should replace {{actionType}} placeholder', () => {
      const prompt = store.generatePrompt('msg-1', 'chat-1', 'with_type', undefined, 'button');
      expect(prompt).toBe('Type: button, Value: with_type');
    });

    it('should replace form data placeholders', () => {
      const prompt = store.generatePrompt('msg-1', 'chat-1', 'with_form', undefined, undefined, {
        name: 'Alice',
        age: '30',
      });
      expect(prompt).toBe('Name: Alice, Age: 30');
    });

    it('should return undefined for non-existent messageId and chatId', () => {
      expect(store.generatePrompt('non-existent', 'non-existent', 'confirm')).toBeUndefined();
    });

    it('should return undefined for non-existent action value', () => {
      expect(store.generatePrompt('msg-1', 'chat-1', 'non_existent')).toBeUndefined();
    });

    it('should handle template with no placeholders', () => {
      store.register('msg-2', 'chat-1', { click: 'Fixed prompt text' });
      expect(store.generatePrompt('msg-2', 'chat-1', 'click')).toBe('Fixed prompt text');
    });

    it('should handle undefined actionText by replacing with empty string', () => {
      store.register('msg-3', 'chat-1', {
        action: '[用户操作] {{actionText}}选择了{{actionValue}}',
      });
      const prompt = store.generatePrompt('msg-3', 'chat-1', 'action', undefined);
      expect(prompt).toBe('[用户操作] 选择了action');
    });
  });

  describe('generatePrompt — multi-card scenarios (#1625)', () => {
    it('should find correct card when multiple cards coexist in same chat', () => {
      // IPC script sends card A
      store.register('msg-card-a', 'chat-1', {
        explain_ai: '[用户操作] 用户想了解 AI 解释',
        ai_history: '[用户操作] 用户想了解 AI 历史',
      });

      // Agent sends card B (registered after card A, would have overwritten old index)
      store.register('msg-card-b', 'chat-1', {
        confirm: '[用户操作] 用户确认了',
        cancel: '[用户操作] 用户取消了',
      });

      // User clicks button on card A — exact match fails, chatId fallback should find card A
      const prompt = store.generatePrompt('real_feishu_id', 'chat-1', 'explain_ai');
      expect(prompt).toBe('[用户操作] 用户想了解 AI 解释');
    });

    it('should find correct card for each action across multiple cards', () => {
      store.register('msg-card-a', 'chat-1', {
        option_a1: 'Prompt A1',
        option_a2: 'Prompt A2',
      });
      store.register('msg-card-b', 'chat-1', {
        option_b1: 'Prompt B1',
      });
      store.register('msg-card-c', 'chat-1', {
        option_c1: 'Prompt C1',
        option_c2: 'Prompt C2',
      });

      expect(store.generatePrompt('unknown', 'chat-1', 'option_a1')).toBe('Prompt A1');
      expect(store.generatePrompt('unknown', 'chat-1', 'option_b1')).toBe('Prompt B1');
      expect(store.generatePrompt('unknown', 'chat-1', 'option_c2')).toBe('Prompt C2');
    });
  });

  describe('unregister', () => {
    it('should remove action prompts for a message', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      expect(store.unregister('msg-1')).toBe(true);
      expect(store.getActionPrompts('msg-1')).toBeUndefined();
    });

    it('should return false for non-existent messageId', () => {
      expect(store.unregister('non-existent')).toBe(false);
    });

    it('should clean up chatId index on unregister', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.unregister('msg-1');
      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
    });

    it('should not affect other cards when unregistering one of multiple cards', () => {
      store.register('msg-a', 'chat-1', { a: 'Card A' });
      store.register('msg-b', 'chat-1', { b: 'Card B' });
      store.register('msg-c', 'chat-1', { c: 'Card C' });

      store.unregister('msg-b');

      // msg-a and msg-c should still be accessible
      expect(store.getActionPrompts('msg-a')).toEqual({ a: 'Card A' });
      expect(store.getActionPrompts('msg-c')).toEqual({ c: 'Card C' });
      expect(store.getActionPromptsByChatId('chat-1', 'a')).toEqual({ a: 'Card A' });
      expect(store.getActionPromptsByChatId('chat-1', 'c')).toEqual({ c: 'Card C' });
    });

    it('should not clean up chatId index if other messageIds exist', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });
      store.unregister('msg-1');
      // chatId index should still work for msg-2
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
    });
  });

  describe('cleanupExpired', () => {
    it('should clean up expired contexts', () => {
      const shortMaxAge = 100; // 100ms
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old', 'chat-1', { ok: 'OK' });

      // Wait for expiration
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          store.register('msg-new', 'chat-1', { ok: 'OK' });
          const cleaned = store.cleanupExpired();
          expect(cleaned).toBe(1);
          expect(store.getActionPrompts('msg-old')).toBeUndefined();
          expect(store.getActionPrompts('msg-new')).toBeDefined();
          // chatId index should point to the non-expired context
          expect(store.getActionPromptsByChatId('chat-1')).toBeDefined();
          resolve();
        }, 150);
      });
    });

    it('should return 0 when no contexts are expired', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      expect(store.cleanupExpired()).toBe(0);
      expect(store.size).toBe(1);
    });

    it('should preserve non-expired cards when cleaning up expired ones', () => {
      const shortMaxAge = 100; // 100ms
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old', 'chat-1', { a: 'A' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Register new card after old one expired
          store.register('msg-new', 'chat-1', { b: 'B' });
          const cleaned = store.cleanupExpired();

          expect(cleaned).toBe(1);
          // New card should still be accessible
          expect(store.getActionPrompts('msg-new')).toEqual({ b: 'B' });
          expect(store.getActionPromptsByChatId('chat-1', 'b')).toEqual({ b: 'B' });
          // Old card should be gone
          expect(store.getActionPrompts('msg-old')).toBeUndefined();
          resolve();
        }, 150);
      });
    });
  });

  describe('size and clear', () => {
    it('should track the number of contexts', () => {
      expect(store.size).toBe(0);
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      expect(store.size).toBe(1);
      store.register('msg-2', 'chat-1', { ok: 'OK' });
      expect(store.size).toBe(2);
    });

    it('should clear all contexts and index', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-2', { ok: 'OK' });
      store.clear();
      expect(store.size).toBe(0);
      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
      expect(store.getActionPromptsByChatId('chat-2')).toBeUndefined();
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when exceeding MAX_ENTRIES_PER_CHAT', () => {
      // Register more than 10 cards for the same chat
      for (let i = 0; i < 15; i++) {
        store.register(`msg-${i}`, 'chat-1', { action: `Card ${i}` });
      }

      // Oldest 5 should be evicted from the chatId index
      // (but contexts themselves remain — only the index is evicted)
      expect(store.size).toBe(15);

      // Cards 0-4 should NOT be found via chatId fallback
      expect(store.getActionPromptsByChatId('chat-1', 'action')).toEqual({
        action: 'Card 14',
      });

      // But they should still be accessible via exact messageId
      expect(store.getActionPrompts('msg-0')).toEqual({ action: 'Card 0' });
      expect(store.getActionPrompts('msg-14')).toEqual({ action: 'Card 14' });
    });

    it('should handle re-registration correctly with LRU', () => {
      // Fill up 10 slots
      for (let i = 0; i < 10; i++) {
        store.register(`msg-${i}`, 'chat-1', { [`action_${i}`]: `Card ${i}` });
      }

      // Re-register msg-2 (moves to end)
      store.register('msg-2', 'chat-1', { action_2: 'Card 2 updated' });

      // Add one more to trigger eviction
      store.register('msg-10', 'chat-1', { action_10: 'Card 10' });

      // msg-0 (the oldest) should be evicted from index
      // msg-2 should still be in index (was moved to end by re-register)
      expect(store.getActionPromptsByChatId('chat-1', 'action_0')).toBeUndefined();
      expect(store.getActionPromptsByChatId('chat-1', 'action_2')).toEqual({
        action_2: 'Card 2 updated',
      });
      expect(store.getActionPromptsByChatId('chat-1', 'action_10')).toEqual({
        action_10: 'Card 10',
      });
    });
  });
});
