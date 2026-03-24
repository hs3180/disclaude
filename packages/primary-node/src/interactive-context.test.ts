/**
 * Tests for InteractiveContextStore.
 *
 * Part of Issue #1568: IPC layer responsibility refactoring.
 * Phase 3 (#1572): Move interactive context management to Primary Node.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InteractiveContextStore } from './interactive-context.js';

describe('InteractiveContextStore', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
    vi.useFakeTimers();
  });

  describe('register', () => {
    it('should store action prompts by messageId', () => {
      store.register('msg-1', 'chat-1', { confirm: 'User confirmed', cancel: 'User cancelled' });
      expect(store.getByMessageId('msg-1')).toEqual({ confirm: 'User confirmed', cancel: 'User cancelled' });
    });

    it('should store action prompts by chatId for fallback', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Confirmed!' });
      expect(store.getByChatId('chat-1')).toEqual({ confirm: 'Confirmed!' });
    });

    it('should overwrite previous context for the same messageId', () => {
      store.register('msg-1', 'chat-1', { action1: 'prompt1' });
      store.register('msg-1', 'chat-2', { action2: 'prompt2' });
      expect(store.getByMessageId('msg-1')).toEqual({ action2: 'prompt2' });
    });
  });

  describe('get (with fallback)', () => {
    it('should find prompts by messageId (primary)', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Confirmed!' });
      expect(store.get('msg-1')).toEqual({ confirm: 'Confirmed!' });
    });

    it('should fall back to chatId lookup', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Confirmed!' });
      expect(store.get('different-msg-id', 'chat-1')).toEqual({ confirm: 'Confirmed!' });
    });

    it('should return undefined when not found', () => {
      expect(store.get('non-existent')).toBeUndefined();
      expect(store.get('non-existent', 'non-existent-chat')).toBeUndefined();
    });

    it('should prefer messageId over chatId when both match', () => {
      store.register('msg-1', 'chat-1', { fromMsg: 'by message' });
      expect(store.get('msg-1', 'chat-1')).toEqual({ fromMsg: 'by message' });
    });
  });

  describe('generatePrompt', () => {
    it('should generate prompt from template', () => {
      store.register('msg-1', 'chat-1', {
        confirm: 'User clicked {{actionText}} button',
      });
      const prompt = store.generatePrompt('msg-1', 'confirm', 'OK');
      expect(prompt).toBe('User clicked OK button');
    });

    it('should replace {{actionValue}} placeholder', () => {
      store.register('msg-1', 'chat-1', {
        select: 'User selected {{actionValue}}',
      });
      const prompt = store.generatePrompt('msg-1', 'select');
      expect(prompt).toBe('User selected select');
    });

    it('should replace {{actionType}} placeholder', () => {
      store.register('msg-1', 'chat-1', {
        action: 'Type: {{actionType}}, Value: {{actionValue}}',
      });
      const prompt = store.generatePrompt('msg-1', 'action', undefined, 'button');
      expect(prompt).toBe('Type: button, Value: action');
    });

    it('should return undefined for non-existent messageId', () => {
      const prompt = store.generatePrompt('non-existent', 'confirm');
      expect(prompt).toBeUndefined();
    });

    it('should return undefined for non-existent action value', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Yes' });
      const prompt = store.generatePrompt('msg-1', 'cancel');
      expect(prompt).toBeUndefined();
    });

    it('should use chatId fallback for prompt generation', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Confirmed!' });
      const prompt = store.generatePrompt('different-msg', 'confirm', undefined, undefined, 'chat-1');
      expect(prompt).toBe('Confirmed!');
    });
  });

  describe('unregister', () => {
    it('should remove context by messageId', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Yes' });
      expect(store.getByMessageId('msg-1')).toBeDefined();

      const result = store.unregister('msg-1');
      expect(result).toBe(true);
      expect(store.getByMessageId('msg-1')).toBeUndefined();
    });

    it('should also remove chatId index on unregister', () => {
      store.register('msg-1', 'chat-1', { confirm: 'Yes' });
      store.unregister('msg-1');
      expect(store.getByChatId('chat-1')).toBeUndefined();
    });

    it('should return false for non-existent messageId', () => {
      expect(store.unregister('non-existent')).toBe(false);
    });

    it('should not remove chatId index if it points to a different messageId', () => {
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-1', { b: '2' }); // overwrites chatId index
      store.unregister('msg-1');
      // chatId index now points to msg-2, so it should still be there
      expect(store.getByChatId('chat-1')).toEqual({ b: '2' });
    });
  });

  describe('cleanupExpired', () => {
    it('should remove contexts older than 24 hours', () => {
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-2', { b: '2' });

      // Advance time past MAX_AGE (24 hours + 1ms)
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(2);
      expect(store.size).toBe(0);
    });

    it('should not remove recent contexts', () => {
      store.register('msg-1', 'chat-1', { a: '1' });

      // Advance time just under MAX_AGE
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);

      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(0);
      expect(store.size).toBe(1);
    });

    it('should only remove expired contexts', () => {
      store.register('msg-old', 'chat-old', { a: '1' });

      // Advance time past MAX_AGE
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

      // Register a new context (uses the advanced time)
      store.register('msg-new', 'chat-new', { b: '2' });

      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(1);
      expect(store.size).toBe(1);
      expect(store.getByMessageId('msg-new')).toBeDefined();
    });
  });

  describe('size', () => {
    it('should return 0 for empty store', () => {
      expect(store.size).toBe(0);
    });

    it('should return correct count', () => {
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-2', { b: '2' });
      expect(store.size).toBe(2);
    });

    it('should decrease after unregister', () => {
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-2', { b: '2' });
      store.unregister('msg-1');
      expect(store.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all contexts', () => {
      store.register('msg-1', 'chat-1', { a: '1' });
      store.register('msg-2', 'chat-2', { b: '2' });
      store.clear();
      expect(store.size).toBe(0);
    });
  });
});
