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

    it('should update chatId index when registering (most recent last)', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should return the most recent context
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should support multiple cards per chatId', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A prompt' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B prompt' });

      expect(store.getActionPrompts('msg-a')).toEqual({ action_a: 'Card A prompt' });
      expect(store.getActionPrompts('msg-b')).toEqual({ action_b: 'Card B prompt' });
      expect(store.size).toBe(2);
    });

    it('should move existing messageId to end of list on re-register (update)', () => {
      store.register('msg-1', 'chat-1', { old: 'Old' });
      store.register('msg-2', 'chat-1', { mid: 'Mid' });
      store.register('msg-1', 'chat-1', { updated: 'Updated' });

      // msg-1 should now be the most recent
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ updated: 'Updated' });
      expect(store.size).toBe(2);
    });

    it('should evict oldest entries when exceeding MAX_ENTRIES_PER_CHAT', () => {
      const max = InteractiveContextStore.MAX_ENTRIES_PER_CHAT;
      for (let i = 0; i < max + 2; i++) {
        store.register(`msg-${i}`, 'chat-1', { [`action_${i}`]: `Prompt ${i}` });
      }

      // Oldest entries should be evicted
      expect(store.getActionPrompts('msg-0')).toBeUndefined();
      expect(store.getActionPrompts('msg-1')).toBeUndefined();
      // Most recent entries should still exist
      expect(store.getActionPrompts(`msg-${max + 1}`)).toBeDefined();
      expect(store.size).toBe(max);
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

    it('should return the context that contains the specified actionValue', () => {
      // Issue #1625: multi-card scenario
      store.register('msg-a', 'chat-1', { explain_ai: 'Tell me about AI', ai_history: 'AI history' });
      store.register('msg-b', 'chat-1', { other_action: 'Other action' });

      // Even though msg-b is more recent, searching for 'explain_ai' should find msg-a
      expect(store.getActionPromptsByChatId('chat-1', 'explain_ai')).toEqual({
        explain_ai: 'Tell me about AI',
        ai_history: 'AI history',
      });
    });

    it('should return the most recent context when no actionValue matches', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B' });

      // action_c doesn't exist in any context, should return most recent
      expect(store.getActionPromptsByChatId('chat-1', 'action_c')).toEqual({
        action_b: 'Card B',
      });
    });

    it('should return the most recent context when actionValue is not provided', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B' });

      expect(store.getActionPromptsByChatId('chat-1')).toEqual({
        action_b: 'Card B',
      });
    });

    it('should clean up all stale entries and return undefined', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B' });
      store.unregister('msg-a');
      store.unregister('msg-b');

      expect(store.getActionPromptsByChatId('chat-1', 'action_a')).toBeUndefined();
      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
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

  describe('generatePrompt - multi-card chatId fallback (Issue #1625)', () => {
    it('should find correct card when multiple cards exist in same chat', () => {
      // Simulate: IPC script sends card A, then Agent sends card B
      store.register('msg-a', 'chat-1', {
        explain_ai: 'Tell me about AI',
        ai_applications: 'AI applications',
        ai_history: 'AI history',
      });
      store.register('msg-b', 'chat-1', {
        other_action: 'Some other action',
      });

      // User clicks card A's button — exact match fails (synthetic vs real messageId)
      // chatId fallback should search all contexts and find msg-a's actionPrompts
      const prompt = store.generatePrompt('real_feishu_id_for_a', 'chat-1', 'explain_ai', '了解AI');
      expect(prompt).toBe('Tell me about AI');
    });

    it('should find correct card regardless of registration order', () => {
      store.register('msg-agent', 'chat-1', {
        agent_action: 'Agent card action',
      });
      store.register('msg-script', 'chat-1', {
        script_action: 'Script card action',
      });

      // Clicking on agent card button should still find agent's action
      const prompt = store.generatePrompt('unknown_id', 'chat-1', 'agent_action');
      expect(prompt).toBe('Agent card action');
    });

    it('should return most recent context when actionValue matches multiple cards', () => {
      store.register('msg-a', 'chat-1', {
        common: 'Card A common action',
      });
      store.register('msg-b', 'chat-1', {
        common: 'Card B common action',
      });

      // 'common' exists in both — should return the most recent (msg-b)
      const prompt = store.generatePrompt('unknown_id', 'chat-1', 'common');
      expect(prompt).toBe('Card B common action');
    });

    it('should fallback to generic text when actionValue matches no card', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B' });

      // action_c doesn't exist in any context — returns undefined (caller handles fallback)
      const prompt = store.generatePrompt('unknown_id', 'chat-1', 'action_c');
      expect(prompt).toBeUndefined();
    });

    it('should still work with exact messageId match even in multi-card scenario', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B' });

      // Exact match should still work
      expect(store.generatePrompt('msg-a', 'chat-1', 'action_a')).toBe('Card A');
      expect(store.generatePrompt('msg-b', 'chat-1', 'action_b')).toBe('Card B');
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

    it('should not affect other contexts when unregistering one in multi-card chat', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });
      store.unregister('msg-1');

      // msg-2 should still be accessible
      expect(store.getActionPrompts('msg-2')).toEqual({ ok: 'OK2' });
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
    });

    it('should allow chatId fallback to find remaining cards after unregister', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B' });
      store.unregister('msg-b');

      // action_a should still be findable via chatId fallback
      const prompt = store.generatePrompt('unknown_id', 'chat-1', 'action_a');
      expect(prompt).toBe('Card A');
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

    it('should clean up expired entries from chatId index array', () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old', 'chat-1', { old_action: 'Old' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Register a new non-expired context after the old one expired
          store.register('msg-new', 'chat-2', { new_action: 'New' });
          const cleaned = store.cleanupExpired();
          expect(cleaned).toBe(1);
          // chat-1 index should be cleaned up (all entries expired)
          expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
          // chat-2 should still work
          expect(store.getActionPromptsByChatId('chat-2')).toEqual({ new_action: 'New' });
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
