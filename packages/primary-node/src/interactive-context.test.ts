/**
 * Tests for InteractiveContextStore.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
 * Issue #1625: Added tests for multi-card coexistence in the same chat.
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

    it('should append to chatId index when registering different messageIds for the same chat', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });

      // chatId index should still return the newest context's prompts
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should keep both entries when registering multiple cards for the same chat (Issue #1625)', () => {
      store.register('msg-script', 'chat-1', {
        explain_ai: 'Explain AI',
        ai_applications: 'AI applications',
      });
      store.register('msg-agent', 'chat-1', {
        status: 'Check status',
        settings: 'Open settings',
      });

      // Both cards should be individually accessible
      expect(store.getActionPrompts('msg-script')).toEqual({
        explain_ai: 'Explain AI',
        ai_applications: 'AI applications',
      });
      expect(store.getActionPrompts('msg-agent')).toEqual({
        status: 'Check status',
        settings: 'Open settings',
      });
      expect(store.size).toBe(2);
    });

    it('should evict oldest entries when maxEntriesPerChat is exceeded', () => {
      const limitedStore = new InteractiveContextStore(undefined, 3);
      limitedStore.register('msg-1', 'chat-1', { a: '1' });
      limitedStore.register('msg-2', 'chat-1', { b: '2' });
      limitedStore.register('msg-3', 'chat-1', { c: '3' });
      limitedStore.register('msg-4', 'chat-1', { d: '4' });

      // msg-1 should be evicted from the index but still in contexts
      expect(limitedStore.getActionPrompts('msg-1')).toEqual({ a: '1' });
      expect(limitedStore.getActionPrompts('msg-4')).toEqual({ d: '4' });
      expect(limitedStore.size).toBe(4);

      // chatId fallback should return newest (msg-4)
      expect(limitedStore.getActionPromptsByChatId('chat-1')).toEqual({ d: '4' });
    });

    it('should not duplicate messageId in chatId index on re-register', () => {
      store.register('msg-1', 'chat-1', { a: 'v1' });
      store.register('msg-2', 'chat-1', { b: 'v2' });
      store.register('msg-1', 'chat-1', { a: 'v1-updated' });

      expect(store.size).toBe(2);
      expect(store.getActionPrompts('msg-1')).toEqual({ a: 'v1-updated' });
      expect(store.getActionPrompts('msg-2')).toEqual({ b: 'v2' });
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
    it('should return prompts for the newest context in a chat', () => {
      store.register('msg-1', 'chat-1', { old: 'Old prompt' });
      store.register('msg-2', 'chat-1', { new: 'New prompt' });

      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ new: 'New prompt' });
    });

    it('should return undefined for non-existent chatId', () => {
      expect(store.getActionPromptsByChatId('non-existent')).toBeUndefined();
    });

    it('should clean up stale index entries when all contexts are gone', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.unregister('msg-1');

      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
    });

    it('should return older context when newest is unregistered (Issue #1625)', () => {
      store.register('msg-old', 'chat-1', { old_action: 'Old prompt' });
      store.register('msg-new', 'chat-1', { new_action: 'New prompt' });

      // Unregister the newest
      store.unregister('msg-new');

      // Should fall back to the older context
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ old_action: 'Old prompt' });
    });

    it('should return oldest context when all newer ones are unregistered', () => {
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-1', { b: '2' });
      store.register('msg-3', 'chat-1', { c: '3' });

      store.unregister('msg-3');
      store.unregister('msg-2');

      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ a: '1' });
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

  describe('generatePrompt — multi-card scenarios (Issue #1625)', () => {
    it('should find action in older card when newest card does not have the action', () => {
      // Card A (sent first via IPC script) with specific actions
      store.register('msg-script', 'chat-1', {
        explain_ai: 'Explain AI in detail',
        ai_applications: 'List AI applications',
        ai_history: 'History of AI development',
      });

      // Card B (sent later by Agent) with different actions
      store.register('msg-agent', 'chat-1', {
        status: 'Check status',
        settings: 'Open settings',
      });

      // Simulate clicking a button on Card A — messageId doesn't match exactly
      // so fallback to chatId search. Should find Card A's actionPrompts.
      const prompt = store.generatePrompt(
        'real_feishu_msg_id_for_card_a',
        'chat-1',
        'explain_ai',
        '解释AI'
      );
      expect(prompt).toBe('Explain AI in detail');
    });

    it('should prefer newer card when both cards have the same actionValue', () => {
      store.register('msg-old', 'chat-1', { action: 'Old card prompt' });
      store.register('msg-new', 'chat-1', { action: 'New card prompt' });

      const prompt = store.generatePrompt('unknown_msg', 'chat-1', 'action');
      expect(prompt).toBe('New card prompt');
    });

    it('should resolve actions from the correct card in a multi-card scenario', () => {
      store.register('card-a', 'chat-1', { btn_a: 'Card A action' });
      store.register('card-b', 'chat-1', { btn_b: 'Card B action' });
      store.register('card-c', 'chat-1', { btn_c: 'Card C action' });

      // Exact match still works
      expect(store.generatePrompt('card-a', 'chat-1', 'btn_a')).toBe('Card A action');
      expect(store.generatePrompt('card-b', 'chat-1', 'btn_b')).toBe('Card B action');
      expect(store.generatePrompt('card-c', 'chat-1', 'btn_c')).toBe('Card C action');

      // Fallback finds correct card by actionValue
      expect(store.generatePrompt('unknown', 'chat-1', 'btn_a')).toBe('Card A action');
      expect(store.generatePrompt('unknown', 'chat-1', 'btn_b')).toBe('Card B action');
      expect(store.generatePrompt('unknown', 'chat-1', 'btn_c')).toBe('Card C action');
    });

    it('should still resolve after middle card is unregistered', () => {
      store.register('card-a', 'chat-1', { a: 'A' });
      store.register('card-b', 'chat-1', { b: 'B' });
      store.register('card-c', 'chat-1', { c: 'C' });

      store.unregister('card-b');

      expect(store.generatePrompt('unknown', 'chat-1', 'a')).toBe('A');
      expect(store.generatePrompt('unknown', 'chat-1', 'c')).toBe('C');
      expect(store.generatePrompt('unknown', 'chat-1', 'b')).toBeUndefined();
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

    it('should clean up chatId index on unregister when only one entry exists', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK' });
      store.unregister('msg-1');
      expect(store.getActionPromptsByChatId('chat-1')).toBeUndefined();
    });

    it('should not remove chatId index when other entries exist (Issue #1625)', () => {
      store.register('msg-1', 'chat-1', { ok: 'OK1' });
      store.register('msg-2', 'chat-1', { ok: 'OK2' });
      store.unregister('msg-1');
      // chatId index should still work for msg-2
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
    });

    it('should preserve older entries when newest is unregistered (Issue #1625)', () => {
      store.register('msg-old', 'chat-1', { old: 'Old' });
      store.register('msg-new', 'chat-1', { new: 'New' });
      store.unregister('msg-new');
      // Should fall back to older context
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ old: 'Old' });
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
          // chatId index should still work for the non-expired context
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

    it('should clean up expired entries while preserving non-expired ones in the same chat (Issue #1625)', () => {
      const shortMaxAge = 100;
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old-1', 'chat-1', { a: 'A' });
      store.register('msg-old-2', 'chat-1', { b: 'B' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          store.register('msg-new', 'chat-1', { c: 'C' });
          const cleaned = store.cleanupExpired();
          expect(cleaned).toBe(2);
          expect(store.getActionPrompts('msg-old-1')).toBeUndefined();
          expect(store.getActionPrompts('msg-old-2')).toBeUndefined();
          expect(store.getActionPrompts('msg-new')).toEqual({ c: 'C' });
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

  describe('constructor options', () => {
    it('should accept custom maxEntriesPerChat', () => {
      const store = new InteractiveContextStore(undefined, 2);
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-1', { b: '2' });
      store.register('msg-3', 'chat-1', { c: '3' });

      // msg-1 evicted from index, but still in contexts
      expect(store.size).toBe(3);
      expect(store.getActionPrompts('msg-1')).toEqual({ a: '1' });

      // Fallback should find msg-3 (newest)
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ c: '3' });
    });

    it('should default maxEntriesPerChat to 10', () => {
      const store = new InteractiveContextStore();
      for (let i = 0; i < 15; i++) {
        store.register(`msg-${i}`, 'chat-1', { [`${i}`]: String(i) });
      }
      // All 15 should be in contexts
      expect(store.size).toBe(15);
      // But only last 10 in the index (msg-5 through msg-14)
      expect(store.getActionPrompts('msg-0')).toEqual({ '0': '0' });
      expect(store.getActionPrompts('msg-4')).toEqual({ '4': '4' });
    });
  });
});
