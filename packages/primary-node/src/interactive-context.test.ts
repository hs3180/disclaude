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

      // chatId index should point to the latest messageId
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ ok: 'OK2' });
      expect(store.size).toBe(2);
    });

    it('should support multiple cards per chatId (LRU)', () => {
      // Register 3 cards in the same chat with different action prompts
      store.register('card-a', 'chat-1', { explain_ai: 'Tell me about AI' });
      store.register('card-b', 'chat-1', { weather: 'Show weather' });
      store.register('card-c', 'chat-1', { news: 'Show news' });

      expect(store.size).toBe(3);

      // getActionPromptsByChatId still returns the most recent
      expect(store.getActionPromptsByChatId('chat-1')).toEqual({ news: 'Show news' });

      // findPromptsByChatIdAndAction can find actions from older cards
      expect(store.findPromptsByChatIdAndAction('chat-1', 'explain_ai')).toEqual({
        explain_ai: 'Tell me about AI',
      });
      expect(store.findPromptsByChatIdAndAction('chat-1', 'weather')).toEqual({
        weather: 'Show weather',
      });
      expect(store.findPromptsByChatIdAndAction('chat-1', 'news')).toEqual({
        news: 'Show news',
      });
      expect(store.findPromptsByChatIdAndAction('chat-1', 'nonexistent')).toBeUndefined();
    });

    it('should evict oldest entries when exceeding MAX_ENTRIES_PER_CHAT', () => {
      // Register more cards than the max limit
      for (let i = 0; i < InteractiveContextStore.MAX_ENTRIES_PER_CHAT + 3; i++) {
        store.register(`card-${i}`, 'chat-1', { action: `prompt-${i}` });
      }

      // Should not exceed MAX_ENTRIES_PER_CHAT
      expect(store.size).toBe(InteractiveContextStore.MAX_ENTRIES_PER_CHAT);

      // Oldest entries should be evicted
      expect(store.getActionPrompts('card-0')).toBeUndefined();
      expect(store.getActionPrompts('card-1')).toBeUndefined();
      expect(store.getActionPrompts('card-2')).toBeUndefined();

      // Newest entries should still exist
      const lastIdx = InteractiveContextStore.MAX_ENTRIES_PER_CHAT + 2;
      expect(store.getActionPrompts(`card-${lastIdx}`)).toEqual({
        action: `prompt-${lastIdx}`,
      });
    });

    it('should not evict entries from different chats', () => {
      for (let i = 0; i < InteractiveContextStore.MAX_ENTRIES_PER_CHAT + 2; i++) {
        store.register(`chat1-card-${i}`, 'chat-1', { action: `prompt-${i}` });
      }
      store.register('chat2-card-0', 'chat-2', { other: 'other prompt' });

      // chat-1 should have been evicted down to max
      expect(store.getActionPrompts('chat2-card-0')).toBeDefined();
      // chat-2 should not be affected
      expect(store.findPromptsByChatIdAndAction('chat-2', 'other')).toEqual({
        other: 'other prompt',
      });
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

    it('should find actionValue from older card when newest card does not have it (multi-card bug fix)', () => {
      // This is the core bug fix test for #1625
      // Card A (older) has action 'explain_ai'
      store.register('card-a', 'chat-1', {
        explain_ai: '[用户操作] 用户想了解「{{actionText}}」',
        ai_applications: '[用户操作] 用户想了解AI应用场景',
      });
      // Card B (newer) has different actions - this would previously overwrite Card A's index
      store.register('card-b', 'chat-1', {
        weather: '[用户操作] 用户想查看天气',
      });

      // User clicks Card A's 'explain_ai' button with a real Feishu messageId (not synthetic)
      const prompt = store.generatePrompt(
        'real_feishu_msg_id', // doesn't match 'card-a' synthetic ID
        'chat-1',
        'explain_ai',
        'AI的发展趋势'
      );

      // Should find the correct prompt from Card A, not fail because Card B is the "latest"
      expect(prompt).toBe('[用户操作] 用户想了解「AI的发展趋势」');
    });

    it('should return undefined when actionValue does not exist in any card for the chat', () => {
      store.register('card-a', 'chat-1', { action1: 'prompt1' });
      store.register('card-b', 'chat-1', { action2: 'prompt2' });

      // Neither card has 'nonexistent'
      const prompt = store.generatePrompt('unknown_msg_id', 'chat-1', 'nonexistent');
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

    it('should remove specific messageId from LRU array without affecting others', () => {
      store.register('msg-1', 'chat-1', { a1: 'A1' });
      store.register('msg-2', 'chat-1', { a2: 'A2' });
      store.register('msg-3', 'chat-1', { a3: 'A3' });

      store.unregister('msg-2');

      // msg-1 and msg-3 should still be accessible
      expect(store.getActionPrompts('msg-1')).toEqual({ a1: 'A1' });
      expect(store.getActionPrompts('msg-2')).toBeUndefined();
      expect(store.getActionPrompts('msg-3')).toEqual({ a3: 'A3' });
      // findPromptsByChatIdAndAction should still find msg-1's actions
      expect(store.findPromptsByChatIdAndAction('chat-1', 'a1')).toEqual({ a1: 'A1' });
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
