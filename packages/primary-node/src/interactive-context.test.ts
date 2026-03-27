/**
 * Tests for InteractiveContextStore.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
 * Extended to cover multi-card coexistence per chatId (#1625).
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

      // chatId index should return the latest context's prompts
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should support multiple cards per chatId (#1625)', () => {
      // Card A (script): registered first
      store.register('synthetic-card-A', 'chat-1', {
        explain_ai: 'Tell me about AI',
        ai_history: 'AI history timeline',
      });

      // Card B (agent): registered second — should NOT overwrite Card A
      store.register('synthetic-card-B', 'chat-1', {
        agent_action: 'Agent did something',
      });

      // Both cards should be findable
      expect(store.getActionPrompts('synthetic-card-A')).toBeDefined();
      expect(store.getActionPrompts('synthetic-card-B')).toBeDefined();
      expect(store.size).toBe(2);
    });

    it('should deduplicate when re-registering same messageId', () => {
      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });
      store.register('msg-1', 'chat-1', { a_updated: 'A updated' });

      // chatId index should have 2 unique entries, not 3
      const latestPrompts = store.getActionPromptsByChatId('chat-1');
      expect(latestPrompts).toEqual({ a_updated: 'A updated' });
      expect(store.size).toBe(2);
    });

    it('should evict oldest entries when exceeding MAX_ENTRIES_PER_CHAT', () => {
      const max = InteractiveContextStore.MAX_ENTRIES_PER_CHAT;

      // Register max + 1 entries
      for (let i = 0; i < max + 1; i++) {
        store.register(`msg-${i}`, 'chat-1', { action: `prompt-${i}` });
      }

      expect(store.size).toBe(max + 1);

      // The oldest entry (msg-0) should have been evicted from the chatId index
      // but still exists in contexts
      expect(store.getActionPrompts('msg-0')).toBeDefined();
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

    it('should skip stale entries and find next valid one', () => {
      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });
      // Manually remove msg-2 from contexts but leave in index
      store.unregister('msg-2');

      // Should fall through to msg-1
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ a: 'A' });
    });
  });

  describe('findActionPrompts', () => {
    it('should find prompts containing the actionValue across multiple cards (#1625)', () => {
      // Card A: script sends interactive card with AI-related actions
      store.register('synthetic-card-A', 'chat-1', {
        explain_ai: 'Tell me about AI',
        ai_history: 'AI history timeline',
        ai_applications: 'AI use cases',
      });

      // Card B: agent sends its own card — previously this would overwrite Card A
      store.register('synthetic-card-B', 'chat-1', {
        agent_action: 'Agent did something',
      });

      // Should find explain_ai in Card A even though Card B is newer
      const prompts = store.findActionPrompts('chat-1', 'explain_ai');
      expect(prompts).toEqual({
        explain_ai: 'Tell me about AI',
        ai_history: 'AI history timeline',
        ai_applications: 'AI use cases',
      });
    });

    it('should find prompts in the most recent card containing the actionValue', () => {
      store.register('msg-1', 'chat-1', { action: 'Card 1 prompt' });
      store.register('msg-2', 'chat-1', { action: 'Card 2 prompt' });
      store.register('msg-3', 'chat-1', { other: 'Card 3 prompt' });

      // action exists in both msg-1 and msg-2, should prefer msg-2 (more recent)
      const prompts = store.findActionPrompts('chat-1', 'action');
      expect(prompts).toEqual({ action: 'Card 2 prompt' });
    });

    it('should return undefined when no card contains the actionValue', () => {
      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });

      expect(store.findActionPrompts('chat-1', 'nonexistent')).toBeUndefined();
    });

    it('should return undefined for non-existent chatId', () => {
      expect(store.findActionPrompts('non-existent', 'action')).toBeUndefined();
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

    it('should find correct actionValue across multiple cards (#1625)', () => {
      // Scenario from the bug report:
      // 1. Script sends card A with AI actions
      store.register('synthetic-card-A', 'chat-group', {
        explain_ai: 'Tell me about AI',
        ai_history: 'AI history timeline',
        ai_applications: 'AI use cases',
      });

      // 2. Agent sends card B (overwrites in old implementation)
      store.register('synthetic-card-B', 'chat-group', {
        agent_continue: 'Continue the task',
        agent_stop: 'Stop the task',
      });

      // 3. User clicks "explain_ai" on card A — real messageId is unknown
      const prompt = store.generatePrompt(
        'real_feishu_msg_id_unknown',
        'chat-group',
        'explain_ai',
        '了解AI'
      );

      // Should find the prompt from card A, not card B
      expect(prompt).toBe('Tell me about AI');
    });

    it('should still prefer exact match over multi-card fallback', () => {
      store.register('card-A', 'chat-1', { action: 'Card A prompt' });
      store.register('card-B', 'chat-1', { action: 'Card B prompt' });

      // Exact match should always win
      const prompt = store.generatePrompt('card-A', 'chat-1', 'action');
      expect(prompt).toBe('Card A prompt');
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
      // chatId index should still point to msg-2
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
    });

    it('should remove from chatId index array without affecting other entries (#1625)', () => {
      store.register('card-A', 'chat-1', { a: 'A' });
      store.register('card-B', 'chat-1', { b: 'B' });
      store.register('card-C', 'chat-1', { c: 'C' });

      // Unregister middle entry
      store.unregister('card-B');

      // card-A and card-C should still be findable
      expect(store.getActionPrompts('card-A')).toEqual({ a: 'A' });
      expect(store.getActionPrompts('card-C')).toEqual({ c: 'C' });
      expect(store.getActionPrompts('card-B')).toBeUndefined();

      // chatId index should still work for remaining cards
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ c: 'C' });
    });

    it('should allow findActionPrompts to find remaining cards after unregister', () => {
      store.register('card-A', 'chat-1', { explain_ai: 'AI prompt' });
      store.register('card-B', 'chat-1', { agent_action: 'Agent prompt' });

      store.unregister('card-B');

      // card-A's action should still be findable via chatId fallback
      const prompts = store.findActionPrompts('chat-1', 'explain_ai');
      expect(prompts).toEqual({ explain_ai: 'AI prompt' });
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

    it('should clean up expired entries from chatId index array (#1625)', () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old', 'chat-1', { old_action: 'Old' });

      // Wait for msg-old to expire, then register msg-new
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          store.register('msg-new', 'chat-1', { new_action: 'New' });
          const cleaned = store.cleanupExpired();
          expect(cleaned).toBe(1);

          // Old entry should be removed from contexts
          expect(store.getActionPrompts('msg-old')).toBeUndefined();

          // But new entry should still be findable
          expect(store.getActionPrompts('msg-new')).toBeDefined();
          expect(store.getActionPromptsByChatId('chat-1')).toEqual({ new_action: 'New' });

          // findActionPrompts should skip expired and find new
          const prompts = store.findActionPrompts('chat-1', 'new_action');
          expect(prompts).toEqual({ new_action: 'New' });

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
});
