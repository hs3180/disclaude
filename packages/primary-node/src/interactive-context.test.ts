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

    it('should update chatId index to latest when registering', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should still return the latest context
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should retain multiple card contexts per chatId', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-2', 'chat-1', { action_b: 'Prompt B' });
      store.register('msg-3', 'chat-1', { action_c: 'Prompt C' });

      // All contexts should be stored
      expect(store.size).toBe(3);
      // Latest should be returned by getActionPromptsByChatId
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ action_c: 'Prompt C' });
      // Each individual context should still be accessible by messageId
      expect(store.getActionPrompts('msg-1')).toEqual({ action_a: 'Prompt A' });
      expect(store.getActionPrompts('msg-2')).toEqual({ action_b: 'Prompt B' });
      expect(store.getActionPrompts('msg-3')).toEqual({ action_c: 'Prompt C' });
    });

    it('should evict oldest entries when exceeding MAX_ENTRIES_PER_CHAT', () => {
      // Register 11 cards for the same chat (MAX_ENTRIES_PER_CHAT = 10)
      for (let i = 1; i <= 11; i++) {
        store.register(`msg-${i}`, 'chat-1', { [`action_${i}`]: `Prompt ${i}` });
      }

      // Only 10 should remain (oldest evicted)
      expect(store.size).toBe(10);
      // msg-1 should have been evicted
      expect(store.getActionPrompts('msg-1')).toBeUndefined();
      // msg-2 through msg-11 should still exist
      expect(store.getActionPrompts('msg-2')).toBeDefined();
      expect(store.getActionPrompts('msg-11')).toBeDefined();
    });

    it('should handle re-registration of same messageId (deduplication)', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-2', 'chat-1', { action_b: 'Prompt B' });
      // Re-register msg-1 with updated prompts
      store.register('msg-1', 'chat-1', { action_a_updated: 'Updated A' });

      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toEqual({ action_a_updated: 'Updated A' });
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

    it('should fall back to a valid context when the latest is stale', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // Directly delete msg-2 from contexts (simulating external cleanup)
      store.unregister('msg-2');

      // Should fall back to msg-1 (still valid)
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK1' });
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

  describe('generatePrompt - multi-card scenarios (Issue #1625)', () => {
    it('should find correct actionValue across multiple cards in same chat', () => {
      // Card A (sent via IPC script) with its own actionPrompts
      store.register('msg-card-a', 'chat-1', {
        explain_ai: '[用户操作] 用户想了解AI技术',
        ai_applications: '[用户操作] 用户想了解AI应用',
      });

      // Card B (sent by Agent via MCP) with different actionPrompts
      store.register('msg-card-b', 'chat-1', {
        start_task: '[用户操作] 用户选择了开始任务',
        cancel: '[用户操作] 用户选择了取消',
      });

      // Simulate user clicking "explain_ai" on Card A
      // Exact messageId won't match (synthetic vs real Feishu ID)
      const prompt = store.generatePrompt('real_feishu_card_a_id', 'chat-1', 'explain_ai');
      expect(prompt).toBe('[用户操作] 用户想了解AI技术');

      // Simulate user clicking "start_task" on Card B
      const prompt2 = store.generatePrompt('real_feishu_card_b_id', 'chat-1', 'start_task');
      expect(prompt2).toBe('[用户操作] 用户选择了开始任务');
    });

    it('should prefer exact messageId match over chatId search', () => {
      store.register('msg-1', 'chat-1', { action: 'Prompt from msg-1' });
      store.register('msg-2', 'chat-1', { action: 'Prompt from msg-2' });

      // Exact match should win
      const prompt = store.generatePrompt('msg-1', 'chat-1', 'action');
      expect(prompt).toBe('Prompt from msg-1');
    });

    it('should search newest-first when multiple cards have the same actionValue', () => {
      store.register('msg-old', 'chat-1', { click: 'Old card prompt' });
      store.register('msg-new', 'chat-1', { click: 'New card prompt' });

      // When no exact match, newest card with matching actionValue wins
      const prompt = store.generatePrompt('real_feishu_id', 'chat-1', 'click');
      expect(prompt).toBe('New card prompt');
    });

    it('should return undefined when actionValue exists in no card for the chat', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Prompt A' });
      store.register('msg-2', 'chat-1', { action_b: 'Prompt B' });

      const prompt = store.generatePrompt('real_id', 'chat-1', 'action_z');
      expect(prompt).toBeUndefined();
    });

    it('should not find actionValue from a different chatId', () => {
      store.register('msg-1', 'chat-1', { secret: 'Secret prompt' });
      store.register('msg-2', 'chat-2', { action_b: 'Chat 2 prompt' });

      // Searching chat-2 should not find chat-1's actionPrompts
      const prompt = store.generatePrompt('real_id', 'chat-2', 'secret');
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

    it('should clean up chatId index on unregister (last entry)', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.unregister('msg-1');
      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
    });

    it('should not affect other contexts when unregistering from multi-card chat', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });
      store.register('msg-3', 'chat-1', { ok: 'OK3' });
      store.unregister('msg-2');

      // msg-1 and msg-3 should still exist
      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toEqual({ ok: 'OK1' });
      expect(store.getActionPrompts('msg-3')).toEqual({ ok: 'OK3' });
      // chatId index should still return the latest (msg-3)
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK3' });
    });

    it('should still allow finding actionValue after unregistering a different card', () => {
      store.register('msg-a', 'chat-1', { action_a: 'Card A prompt' });
      store.register('msg-b', 'chat-1', { action_b: 'Card B prompt' });
      store.register('msg-c', 'chat-1', { action_c: 'Card C prompt' });

      // Unregister card B
      store.unregister('msg-b');

      // Should still find action_a from card A
      const prompt = store.generatePrompt('real_id', 'chat-1', 'action_a');
      expect(prompt).toBe('Card A prompt');

      // Should still find action_c from card C
      const prompt2 = store.generatePrompt('real_id', 'chat-1', 'action_c');
      expect(prompt2).toBe('Card C prompt');
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
      const shortMaxAge = 100; // 100ms
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old-1', 'chat-1', { old1: 'Old 1' });
      store.register('msg-old-2', 'chat-1', { old2: 'Old 2' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          store.register('msg-new', 'chat-1', { new_action: 'New' });
          const cleaned = store.cleanupExpired();

          expect(cleaned).toBe(2);
          expect(store.size).toBe(1);
          // The new context should still be findable
          const prompt = store.generatePrompt('real_id', 'chat-1', 'new_action');
          expect(prompt).toBe('New');
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
