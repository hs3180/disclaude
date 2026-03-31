/**
 * Tests for InteractiveContextStore.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
 * Issue #1625: Tests for multi-card chatId index (LRU) support.
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

    it('should update chatId index when registering (most recent last)', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should return the latest context by default
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should append to chatId index instead of overwriting (Issue #1625)', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-2', 'chat-1', { action_b: 'Prompt B' });

      // Both contexts should exist
      expect(store.getActionPrompts('msg-1')).toEqual({ action_a: 'Prompt A' });
      expect(store.getActionPrompts('msg-2')).toEqual({ action_b: 'Prompt B' });
      expect(store.size).toBe(2);
    });

    it('should not duplicate messageId in chatId index on re-register', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Prompt A v1' });
      store.register('msg-2', 'chat-1', { action_b: 'Prompt B' });
      store.register('msg-1', 'chat-1', { action_a: 'Prompt A v2' });

      expect(store.getActionPrompts('msg-1')).toEqual({ action_a: 'Prompt A v2' });
      expect(store.size).toBe(2);
    });

    it('should evict oldest entries when exceeding MAX_ENTRIES_PER_CHAT', () => {
      // Register 11 cards for the same chat (MAX_ENTRIES_PER_CHAT = 10)
      for (let i = 1; i <= 11; i++) {
        store.register(`msg-${i}`, 'chat-1', { [`action_${i}`]: `Prompt ${i}` });
      }

      expect(store.size).toBe(11); // All contexts are stored

      // msg-1 should be evicted from the index but context still exists
      // The chatId index should not contain msg-1 anymore
      // When looking up by chatId with action_1, it should not be found
      expect(store.getActionPromptsByChatId('chat-1', 'action_1')).toBeUndefined();
      // action_11 should still be found
      expect(store.getActionPromptsByChatId('chat-1', 'action_11')).toEqual({ action_11: 'Prompt 11' });
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

    it('should search by actionValue across multiple cards (Issue #1625)', () => {
      // Card A: IPC script sends interactive card
      store.register('msg-a', 'chat-1', {
        explain_ai: 'Explain AI in detail',
        ai_applications: 'AI applications',
        ai_history: 'History of AI',
      });
      // Card B: Agent sends another interactive card (overwrites in old impl)
      store.register('msg-b', 'chat-1', {
        confirm: 'User confirmed',
        cancel: 'User cancelled',
      });

      // Look up Card A's action from Card B's actionPrompts should fail
      expect(store.getActionPromptsByChatId('chat-1', 'confirm')).toEqual({
        confirm: 'User confirmed',
        cancel: 'User cancelled',
      });

      // Look up Card A's action should now find Card A's prompts
      expect(store.getActionPromptsByChatId('chat-1', 'explain_ai')).toEqual({
        explain_ai: 'Explain AI in detail',
        ai_applications: 'AI applications',
        ai_history: 'History of AI',
      });

      expect(store.getActionPromptsByChatId('chat-1', 'ai_applications')).toEqual({
        explain_ai: 'Explain AI in detail',
        ai_applications: 'AI applications',
        ai_history: 'History of AI',
      });
    });

    it('should return undefined when actionValue not found in any card', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-b', 'chat-1', { action_b: 'Prompt B' });

      expect(store.getActionPromptsByChatId('chat-1', 'non_existent')).toBeUndefined();
    });

    it('should prefer newer card when actionValue exists in multiple cards', () => {
      store.register('msg-a', 'chat-1', { shared: 'Old shared action' });
      store.register('msg-b', 'chat-1', { shared: 'New shared action' });

      // Should find the newer card's prompts (searches newest first)
      expect(store.getActionPromptsByChatId('chat-1', 'shared')).toEqual({
        shared: 'New shared action',
      });
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

    it('should find correct card when multiple cards exist in same chat (Issue #1625)', () => {
      // Card A: IPC script card
      store.register('msg-a', 'chat-1', {
        explain_ai: '[用户操作] 用户想了解{{actionText}}',
        ai_history: '[用户操作] 用户想了解{{actionText}}',
      });
      // Card B: Agent card (registered after Card A)
      store.register('msg-b', 'chat-1', {
        confirm: '[用户操作] 用户选择了「{{actionText}}」',
        cancel: '[用户操作] 用户取消了',
      });

      // Simulate: user clicks "explain_ai" on Card A
      // Real Feishu messageId won't match synthetic IDs, so fallback to chatId
      const prompt = store.generatePrompt('real_feishu_id_a', 'chat-1', 'explain_ai', 'AI解释');
      expect(prompt).toBe('[用户操作] 用户想了解AI解释');

      // Simulate: user clicks "confirm" on Card B
      const prompt2 = store.generatePrompt('real_feishu_id_b', 'chat-1', 'confirm', '确认');
      expect(prompt2).toBe('[用户操作] 用户选择了「确认」');
    });

    it('should return default when actionValue not found in any card of the chat', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-b', 'chat-1', { action_b: 'Prompt B' });

      const prompt = store.generatePrompt('unknown_msg', 'chat-1', 'unknown_action');
      expect(prompt).toBeUndefined();
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
    });

    it('should preserve other cards when unregistering one card (Issue #1625)', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-b', 'chat-1', { action_b: 'Prompt B' });
      store.register('msg-c', 'chat-1', { action_c: 'Prompt C' });

      store.unregister('msg-b');

      // msg-a and msg-c should still be accessible
      expect(store.getActionPromptsByChatId('chat-1', 'action_a')).toEqual({ action_a: 'Prompt A' });
      expect(store.getActionPromptsByChatId('chat-1', 'action_c')).toEqual({ action_c: 'Prompt C' });
      // msg-b should be gone
      expect(store.getActionPromptsByChatId('chat-1', 'action_b')).toBeUndefined();
      expect(store.getActionPrompts('msg-b')).toBeUndefined();
    });

    it('should handle unregistering all cards for a chat', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-b', 'chat-1', { action_b: 'Prompt B' });

      store.unregister('msg-a');
      store.unregister('msg-b');

      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
      expect(store.getActionPromptsByChatId('chat-1', 'action_a')).toBeUndefined();
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

    it('should handle expired contexts with multi-card chatId index (Issue #1625)', async () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old', 'chat-1', { old_action: 'Old' });
      store.register('msg-new', 'chat-1', { new_action: 'New' });

      // Wait for both to expire
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      // Register a fresh context
      store.register('msg-fresh', 'chat-1', { fresh_action: 'Fresh' });

      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(2); // msg-old and msg-new expired
      expect(store.getActionPrompts('msg-old')).toBeUndefined();
      expect(store.getActionPrompts('msg-new')).toBeUndefined();
      // msg-fresh should still be accessible
      expect(store.getActionPromptsByChatId('chat-1', 'fresh_action')).toEqual({ fresh_action: 'Fresh' });
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
