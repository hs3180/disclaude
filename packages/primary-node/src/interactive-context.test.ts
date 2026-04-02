/**
 * Tests for InteractiveContextStore.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
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

    it('should update chatId index when registering', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should return the most recent context's prompts
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should append to chatId index instead of overwriting (fixes #1625)', () => {
      store.register('card-a', 'chat-1', { action_a: 'Card A prompt' });
      store.register('card-b', 'chat-1', { action_b: 'Card B prompt' });

      // Both contexts should still exist
      expect(store.getActionPrompts('card-a')).toEqual({ action_a: 'Card A prompt' });
      expect(store.getActionPrompts('card-b')).toEqual({ action_b: 'Card B prompt' });
      expect(store.size).toBe(2);
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

    it('should return most recent prompts even when older contexts exist', () => {
      store.register('card-a', 'chat-1', { old_action: 'Old prompt' });
      store.register('card-b', 'chat-1', { new_action: 'New prompt' });

      // getActionPromptsByChatId always returns the most recent
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ new_action: 'New prompt' });
    });
  });

  describe('findActionPromptsByActionValue', () => {
    it('should find prompts in an older context when the newest does not contain the action (fixes #1625)', () => {
      // Scenario: Script sends card A, then Agent sends card B in the same chat
      store.register('card-a', 'chat-1', { explain_ai: 'Tell me about AI', ai_history: 'AI history' });
      store.register('card-b', 'chat-1', { confirm: 'Confirmed' });

      // User clicks card A's "explain_ai" button — most recent (card-b) doesn't have it
      const found = store.findActionPromptsByActionValue('chat-1', 'explain_ai');
      expect(found).toEqual({ explain_ai: 'Tell me about AI', ai_history: 'AI history' });
    });

    it('should prefer the newest context when both contain the actionValue', () => {
      store.register('card-a', 'chat-1', { ok: 'Card A OK' });
      store.register('card-b', 'chat-1', { ok: 'Card B OK' });

      const found = store.findActionPromptsByActionValue('chat-1', 'ok');
      expect(found).toEqual({ ok: 'Card B OK' });
    });

    it('should return undefined when no context contains the actionValue', () => {
      store.register('card-a', 'chat-1', { action_a: 'A' });
      store.register('card-b', 'chat-1', { action_b: 'B' });

      expect(store.findActionPromptsByActionValue('chat-1', 'non_existent')).toBeUndefined();
    });

    it('should return undefined for non-existent chatId', () => {
      expect(store.findActionPromptsByActionValue('non-existent', 'any')).toBeUndefined();
    });
  });

  describe('generatePrompt with multiple coexisting cards (fixes #1625)', () => {
    it('should resolve action from older card when newest does not contain the actionValue', () => {
      // Card A (script): synthetic messageId, registered first
      store.register('interactive_chat1_1000', 'chat-1', {
        explain_ai: '[用户操作] 用户选择了「解释AI」',
        ai_applications: '[用户操作] 用户选择了「AI应用」',
      });

      // Card B (Agent): different actionValues, registered after card A
      store.register('interactive_chat1_2000', 'chat-1', {
        confirm: '[用户操作] 用户确认了操作',
        cancel: '[用户操作] 用户取消了操作',
      });

      // User clicks card A's "explain_ai" button with real Feishu messageId
      // 1. Exact match fails (real messageId ≠ synthetic)
      // 2. chatId fallback returns card B (most recent) → no "explain_ai" → fallback
      // 3. findActionPromptsByActionValue finds card A which has "explain_ai"
      const prompt = store.generatePrompt('real_feishu_msg_id', 'chat-1', 'explain_ai', '解释AI');
      expect(prompt).toBe('[用户操作] 用户选择了「解释AI」');
    });

    it('should still resolve from newest card when actionValue exists there', () => {
      store.register('card-a', 'chat-1', { old_action: 'Old' });
      store.register('card-b', 'chat-1', { new_action: 'New' });

      const prompt = store.generatePrompt('unknown_msg_id', 'chat-1', 'new_action', 'New');
      expect(prompt).toBe('New');
    });

    it('should handle three or more coexisting cards correctly', () => {
      store.register('card-1', 'chat-1', { action_1: 'Card 1' });
      store.register('card-2', 'chat-1', { action_2: 'Card 2' });
      store.register('card-3', 'chat-1', { action_3: 'Card 3' });

      // Should find action_1 even though cards 2 and 3 are newer
      const prompt = store.generatePrompt('real_msg', 'chat-1', 'action_1');
      expect(prompt).toBe('Card 1');

      // Should find action_3 from the newest card
      const prompt3 = store.generatePrompt('real_msg', 'chat-1', 'action_3');
      expect(prompt3).toBe('Card 3');
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

    it('should not clean up chatId index if a newer messageId exists', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });
      store.unregister('msg-1');
      // chatId index should still have msg-2
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(1);
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

    it('should prune chatId index after cleaning expired contexts', () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('old-1', 'chat-1', { a: 'A' });
      store.register('old-2', 'chat-1', { b: 'B' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          store.register('new-1', 'chat-1', { c: 'C' });
          const cleaned = store.cleanupExpired();
          expect(cleaned).toBe(2);
          expect(store.getActionPromptsByChatId('chat-1')).toEqual({ c: 'C' });
          resolve();
        }, 150);
      });
    });
  });

  describe('LRU eviction (MAX_ENTRIES_PER_CHAT)', () => {
    it('should evict oldest entry when limit is exceeded', () => {
      // MAX_ENTRIES_PER_CHAT = 10; register 11 contexts for the same chat
      for (let i = 0; i < 11; i++) {
        store.register(`msg-${i}`, 'chat-1', { action: `Prompt ${i}` });
      }

      // Only 10 should remain (msg-0 evicted)
      expect(store.size).toBe(10);
      expect(store.getActionPrompts('msg-0')).toBeUndefined();
      expect(store.getActionPrompts('msg-10')).toBeDefined();
    });

    it('should allow re-registering same messageId (dedup)', () => {
      store.register('msg-1', 'chat-1', { a: 'First' });
      store.register('msg-2', 'chat-1', { b: 'Second' });
      store.register('msg-1', 'chat-1', { a: 'Updated' }); // re-register

      // msg-1 should be moved to the end (most recent)
      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toEqual({ a: 'Updated' });
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
});
