/**
 * Tests for InteractiveContextStore.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
 * Extended with multi-card coexistence tests for Issue #1625.
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

    it('should track multiple cards for the same chatId', () => {
      store.register('msg-1', 'chat-1', { action_a: 'Card A prompt' });
      store.register('msg-2', 'chat-1', { action_b: 'Card B prompt' });

      // Both cards should be accessible
      expect(store.getActionPrompts('msg-1')).toEqual({ action_a: 'Card A prompt' });
      expect(store.getActionPrompts('msg-2')).toEqual({ action_b: 'Card B prompt' });
      expect(store.size).toBe(2);
    });

    it('should evict oldest entries when exceeding maxEntriesPerChat', () => {
      const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 3);

      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-1', { b: '2' });
      store.register('msg-3', 'chat-1', { c: '3' });
      store.register('msg-4', 'chat-1', { d: '4' });

      // msg-1 should be evicted (oldest)
      expect(store.getActionPrompts('msg-1')).toBeUndefined();
      expect(store.getActionPrompts('msg-2')).toEqual({ b: '2' });
      expect(store.getActionPrompts('msg-3')).toEqual({ c: '3' });
      expect(store.getActionPrompts('msg-4')).toEqual({ d: '4' });
      expect(store.size).toBe(3);
    });

    it('should deduplicate when re-registering the same messageId', () => {
      store.register('msg-1', 'chat-1', { a: 'first' });
      store.register('msg-2', 'chat-1', { b: 'second' });
      store.register('msg-1', 'chat-1', { a: 'updated' });

      // msg-1 should be moved to the end (newest), not duplicated
      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toEqual({ a: 'updated' });
      // chatId fallback without actionValue returns newest (msg-1)
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ a: 'updated' });
    });

    it('should update chatId index when registering', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId fallback without actionValue returns newest (msg-2)
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
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
    it('should return prompts for the latest context in a chat (backward compatible)', () => {
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

    it('should search all contexts when actionValue is specified (Issue #1625)', () => {
      // Register card A with its own actionPrompts
      store.register('msg-a', 'chat-1', {
        explain_ai: '[用户操作] 用户想了解AI',
        ai_applications: '[用户操作] 用户想了解AI应用',
      });
      // Register card B (sent later) — would overwrite in old single-value index
      store.register('msg-b', 'chat-1', {
        confirm: '[用户操作] 用户确认了',
      });

      // Looking up card A's action should find it even though card B is newer
      const prompts = store.getActionPromptsByChatId('chat-1', 'explain_ai');
      expect(prompts).toEqual({
        explain_ai: '[用户操作] 用户想了解AI',
        ai_applications: '[用户操作] 用户想了解AI应用',
      });
    });

    it('should return newest matching context when multiple cards have the same actionValue', () => {
      store.register('msg-1', 'chat-1', { ok: 'First OK' });
      store.register('msg-2', 'chat-1', { ok: 'Second OK' });
      store.register('msg-3', 'chat-1', { other: 'Other action' });

      // Should find the newest context containing 'ok' (msg-2)
      const prompts = store.getActionPromptsByChatId('chat-1', 'ok');
      expect(prompts).toEqual({ ok: 'Second OK' });
    });

    it('should return undefined when actionValue does not match any context', () => {
      store.register('msg-a', 'chat-1', { action_a: 'A' });
      store.register('msg-b', 'chat-1', { action_b: 'B' });

      expect(store.getActionPromptsByChatId('chat-1', 'non_existent')).toBeUndefined();
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
    it('should find correct actionPrompt from older card when newer card exists', () => {
      // Scenario: IPC sends card A, then Agent sends card B
      store.register('interactive_chat1_001', 'chat-1', {
        explain_ai: '[用户操作] 用户选择了「了解AI」',
        ai_applications: '[用户操作] 用户选择了「AI应用」',
        ai_history: '[用户操作] 用户选择了「AI历史」',
      });
      // Agent sends a different card to the same chat
      store.register('interactive_chat1_002', 'chat-1', {
        yes: '[用户操作] 用户确认了',
        no: '[用户操作] 用户拒绝了',
      });

      // User clicks button on card A — Feishu callback has real messageId that
      // doesn't match the synthetic messageId used during registration
      const prompt = store.generatePrompt(
        'real_feishu_msg_id_for_card_a',
        'chat-1',
        'explain_ai',
        '了解AI'
      );

      // Should find the correct prompt from card A, not card B
      expect(prompt).toBe('[用户操作] 用户选择了「了解AI」');
    });

    it('should still find action from newest card', () => {
      store.register('msg-old', 'chat-1', { old_action: 'Old prompt' });
      store.register('msg-new', 'chat-1', { new_action: 'New prompt' });

      const prompt = store.generatePrompt('unknown_msg_id', 'chat-1', 'new_action', 'New');
      expect(prompt).toBe('New prompt');
    });

    it('should handle three or more cards in the same chat', () => {
      store.register('card-1', 'chat-1', { a1: 'Card 1 action' });
      store.register('card-2', 'chat-1', { a2: 'Card 2 action' });
      store.register('card-3', 'chat-1', { a3: 'Card 3 action' });

      // Each card's action should be findable
      expect(store.generatePrompt('unknown', 'chat-1', 'a1')).toBe('Card 1 action');
      expect(store.generatePrompt('unknown', 'chat-1', 'a2')).toBe('Card 2 action');
      expect(store.generatePrompt('unknown', 'chat-1', 'a3')).toBe('Card 3 action');
    });

    it('should return undefined when actionValue exists in no card for the chat', () => {
      store.register('card-a', 'chat-1', { a_action: 'A' });
      store.register('card-b', 'chat-1', { b_action: 'B' });

      // actionValue from a different chat's card should not be found
      expect(store.generatePrompt('unknown', 'chat-1', 'z_action')).toBeUndefined();
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

    it('should not affect other cards when unregistering one card', () => {
      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });
      store.register('msg-3', 'chat-1', { c: 'C' });

      store.unregister('msg-2');

      // msg-1 and msg-3 should still be accessible
      expect(store.getActionPrompts('msg-1')).toEqual({ a: 'A' });
      expect(store.getActionPrompts('msg-3')).toEqual({ c: 'C' });
      expect(store.getActionPrompts('msg-2')).toBeUndefined();
      expect(store.size).toBe(2);

      // chatId fallback should still work
      expect(store.getActionPromptsByChatId('chat-1', 'a')).toEqual({ a: 'A' });
      expect(store.getActionPromptsByChatId('chat-1', 'c')).toEqual({ c: 'C' });
    });

    it('should not clean up chatId index if a newer messageId exists', () => {
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

    it('should handle expired entries in multi-card chatId index', () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old', 'chat-1', { old: 'Old' });
      store.register('msg-new', 'chat-1', { new: 'New' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const cleaned = store.cleanupExpired();
          // Both should be expired (msg-new was registered within the same tick)
          expect(cleaned).toBe(2);
          expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
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

  describe('constructor options', () => {
    it('should accept custom maxAge', () => {
      const store = new InteractiveContextStore(5000);
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      expect(store.size).toBe(1);
    });

    it('should accept custom maxEntriesPerChat', () => {
      const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 2);
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-1', { b: '2' });
      store.register('msg-3', 'chat-1', { c: '3' });

      // Only 2 most recent should remain
      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toBeUndefined();
      expect(store.getActionPrompts('msg-2')).toEqual({ b: '2' });
      expect(store.getActionPrompts('msg-3')).toEqual({ c: '3' });
    });
  });
});
