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

    it('should update chatId index when registering', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should point to the latest messageId
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should support multiple contexts for the same chatId (#1625)', () => {
      store.register('msg-a', 'chat-1', { explain_ai: 'Tell me about AI' });
      store.register('msg-b', 'chat-1', { yes: 'User confirmed', no: 'User rejected' });

      // Both contexts should be stored
      expect(store.size).toBe(2);
      // Both should be retrievable by exact messageId
      expect(store.getActionPrompts('msg-a')).toEqual({ explain_ai: 'Tell me about AI' });
      expect(store.getActionPrompts('msg-b')).toEqual({ yes: 'User confirmed', no: 'User rejected' });
      // chatId fallback returns the most recent
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ yes: 'User confirmed', no: 'User rejected' });
    });

    it('should deduplicate when re-registering the same messageId', () => {
      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });
      store.register('msg-1', 'chat-1', { a_updated: 'A updated' });

      // msg-1 should be updated, not duplicated
      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toEqual({ a_updated: 'A updated' });
    });

    it('should evict oldest entries when maxEntriesPerChat is exceeded', () => {
      const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 3);

      store.register('msg-1', 'chat-1', { a: 'A' });
      store.register('msg-2', 'chat-1', { b: 'B' });
      store.register('msg-3', 'chat-1', { c: 'C' });
      store.register('msg-4', 'chat-1', { d: 'D' });

      // Only 3 entries should remain (max is 3)
      expect(store.size).toBe(3);
      // Oldest (msg-1) should be evicted
      expect(store.getActionPrompts('msg-1')).toBeUndefined();
      // Newer entries should remain
      expect(store.getActionPrompts('msg-2')).toEqual({ b: 'B' });
      expect(store.getActionPrompts('msg-3')).toEqual({ c: 'C' });
      expect(store.getActionPrompts('msg-4')).toEqual({ d: 'D' });
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
      store.register('msg-3', 'chat-1', { c: 'C' });

      // Remove the most recent entry
      store.unregister('msg-3');

      // Should fall back to msg-2
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ b: 'B' });
    });
  });

  describe('findActionPromptsByChatId', () => {
    it('should find prompts containing the actionValue across multiple contexts (#1625)', () => {
      // Card A (IPC script) with AI-related actions
      store.register('msg-a', 'chat-1', {
        explain_ai: 'Tell me about AI',
        ai_applications: 'Show AI applications',
        ai_history: 'Show AI history',
      });
      // Card B (Agent) with confirmation actions
      store.register('msg-b', 'chat-1', {
        yes: 'User confirmed',
        no: 'User rejected',
      });

      // Should find 'explain_ai' in Card A even though Card B is newer
      const prompts = store.findActionPromptsByChatId('chat-1', 'explain_ai');
      expect(prompts).toEqual({
        explain_ai: 'Tell me about AI',
        ai_applications: 'Show AI applications',
        ai_history: 'Show AI history',
      });

      // Should find 'yes' in Card B (most recent match)
      const prompts2 = store.findActionPromptsByChatId('chat-1', 'yes');
      expect(prompts2).toEqual({ yes: 'User confirmed', no: 'User rejected' });
    });

    it('should return undefined when actionValue is not found in any context', () => {
      store.register('msg-a', 'chat-1', { a: 'A' });
      store.register('msg-b', 'chat-1', { b: 'B' });

      expect(store.findActionPromptsByChatId('chat-1', 'non_existent')).toBeUndefined();
    });

    it('should return undefined for non-existent chatId', () => {
      expect(store.findActionPromptsByChatId('non-existent', 'any')).toBeUndefined();
    });

    it('should prefer newer contexts when actionValue exists in multiple cards', () => {
      store.register('msg-old', 'chat-1', { action: 'Old prompt' });
      store.register('msg-new', 'chat-1', { action: 'New prompt' });

      const prompts = store.findActionPromptsByChatId('chat-1', 'action');
      expect(prompts).toEqual({ action: 'New prompt' });
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

    it('should find actionValue across multiple cards in the same chat (#1625)', () => {
      // Simulate the exact scenario from the bug report:
      // 1. IPC script sends Card A with AI-related buttons
      store.register('card-a', 'chat-group', {
        explain_ai: '[用户操作] 用户想了解AI解释',
        ai_applications: '[用户操作] 用户想看AI应用',
        ai_history: '[用户操作] 用户想看AI历史',
      });
      // 2. Agent sends Card B with different buttons
      store.register('card-b', 'chat-group', {
        yes: '[用户操作] 用户确认了',
        no: '[用户操作] 用户拒绝了',
      });

      // User clicks Card A's button, but Feishu sends a different messageId
      const prompt = store.generatePrompt(
        'feishu_real_msg_id', // unknown to store
        'chat-group',
        'explain_ai', // belongs to Card A, not Card B
        'AI解释'
      );

      // Should find the correct prompt from Card A, not Card B
      expect(prompt).toBe('[用户操作] 用户想了解AI解释');
    });

    it('should return undefined when actionValue is not in any card of the chat', () => {
      store.register('card-a', 'chat-group', { a: 'A prompt' });
      store.register('card-b', 'chat-group', { b: 'B prompt' });

      const prompt = store.generatePrompt('unknown', 'chat-group', 'non_existent');
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
      // chatId index should still point to msg-2
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
    });

    it('should remove from chatId index array without affecting other entries (#1625)', () => {
      store.register('msg-a', 'chat-1', { a: 'A' });
      store.register('msg-b', 'chat-1', { b: 'B' });
      store.register('msg-c', 'chat-1', { c: 'C' });

      store.unregister('msg-b');

      // msg-a and msg-c should still be accessible
      expect(store.getActionPrompts('msg-a')).toEqual({ a: 'A' });
      expect(store.getActionPrompts('msg-c')).toEqual({ c: 'C' });
      // chatId index should still work
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ c: 'C' });
      // findActionPromptsByChatId should still find 'a'
      expect(store.findActionPromptsByChatId('chat-1', 'a')).toEqual({ a: 'A' });
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

    it('should clean up multiple expired entries from chatId index (#1625)', () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old1', 'chat-1', { a: 'A' });
      store.register('msg-old2', 'chat-1', { b: 'B' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          store.register('msg-new', 'chat-1', { c: 'C' });
          const cleaned = store.cleanupExpired();
          expect(cleaned).toBe(2);
          expect(store.size).toBe(1);
          expect(store.getActionPromptsByChatId('chat-1')).toEqual({ c: 'C' });
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
