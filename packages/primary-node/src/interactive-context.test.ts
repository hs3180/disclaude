/**
 * Tests for InteractiveContextStore.
 *
 * Issue #1572: Phase 3 — Verifies that the Primary Node's interactive context
 * store correctly handles action prompt registration, lookup, prompt generation,
 * and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InteractiveContextStore } from './interactive-context.js';

describe('InteractiveContextStore', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  afterEach(() => {
    store.dispose();
  });

  describe('register', () => {
    it('should register action prompts for a message', () => {
      store.register('msg-1', 'oc_chat1', {
        confirm: '[用户操作] 用户选择了「确认」',
        cancel: '[用户操作] 用户选择了「取消」',
      });

      const prompts = store.get('msg-1');
      expect(prompts).toBeDefined();
      expect(prompts?.confirm).toBe('[用户操作] 用户选择了「确认」');
      expect(prompts?.cancel).toBe('[用户操作] 用户选择了「取消」');
    });

    it('should overwrite existing prompts for the same messageId', () => {
      store.register('msg-1', 'oc_chat1', { confirm: 'original' });
      store.register('msg-1', 'oc_chat1', { confirm: 'updated' });

      const prompts = store.get('msg-1');
      expect(prompts?.confirm).toBe('updated');
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent messageId', () => {
      expect(store.get('non-existent')).toBeUndefined();
    });

    it('should return action prompts for existing messageId', () => {
      store.register('msg-1', 'oc_chat1', { action1: 'prompt1' });
      expect(store.get('msg-1')).toEqual({ action1: 'prompt1' });
    });
  });

  describe('unregister', () => {
    it('should remove existing context and return true', () => {
      store.register('msg-1', 'oc_chat1', { action1: 'prompt1' });
      expect(store.unregister('msg-1')).toBe(true);
      expect(store.get('msg-1')).toBeUndefined();
    });

    it('should return false for non-existent messageId', () => {
      expect(store.unregister('non-existent')).toBe(false);
    });
  });

  describe('generatePrompt', () => {
    beforeEach(() => {
      store.register('msg-1', 'oc_chat1', {
        confirm: '[用户操作] 用户选择了「{{actionText}}」 (value={{actionValue}})',
        submit: '[用户操作] 用户提交了表单，姓名: {{form.name}}',
      });
    });

    it('should generate prompt with actionText placeholder', () => {
      const prompt = store.generatePrompt('msg-1', 'confirm', '确认');
      expect(prompt).toBe('[用户操作] 用户选择了「确认」 (value=confirm)');
    });

    it('should generate prompt with actionValue placeholder', () => {
      const prompt = store.generatePrompt('msg-1', 'confirm', '确认');
      expect(prompt).toContain('value=confirm');
    });

    it('should generate prompt with form data placeholders', () => {
      const prompt = store.generatePrompt('msg-1', 'submit', undefined, undefined, { name: 'Alice' });
      expect(prompt).toBe('[用户操作] 用户提交了表单，姓名: Alice');
    });

    it('should return undefined for non-existent messageId', () => {
      expect(store.generatePrompt('non-existent', 'confirm')).toBeUndefined();
    });

    it('should return undefined for non-existent action value', () => {
      expect(store.generatePrompt('msg-1', 'non-existent')).toBeUndefined();
    });

    it('should handle missing actionText gracefully', () => {
      const prompt = store.generatePrompt('msg-1', 'confirm');
      expect(prompt).toBe('[用户操作] 用户选择了「{{actionText}}」 (value=confirm)');
    });
  });

  describe('cleanupExpired', () => {
    it('should remove contexts older than maxAge', () => {
      store.register('old-msg', 'oc_chat1', { action1: 'prompt1' });
      store.register('new-msg', 'oc_chat2', { action2: 'prompt2' });

      // Manually set createdAt to make 'old-msg' expired
      const contexts = (store as unknown as { contexts: Map<string, { createdAt: number }> }).contexts;
      const oldContext = contexts.get('old-msg');
      if (oldContext) {
        oldContext.createdAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      }

      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(1);
      expect(store.get('old-msg')).toBeUndefined();
      expect(store.get('new-msg')).toBeDefined();
    });

    it('should return 0 when no contexts are expired', () => {
      store.register('msg-1', 'oc_chat1', { action1: 'prompt1' });
      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(0);
      expect(store.size).toBe(1);
    });

    it('should accept custom maxAge', () => {
      store.register('msg-1', 'oc_chat1', { action1: 'prompt1' });
      // Manually backdate the context so it's older than 1ms
      const contexts = (store as unknown as { contexts: Map<string, { createdAt: number }> }).contexts;
      const ctx = contexts.get('msg-1');
      if (ctx) {
        ctx.createdAt = Date.now() - 100; // 100ms ago
      }
      // Clean up with maxAge of 50ms — should remove the 100ms-old context
      const cleaned = store.cleanupExpired(50);
      expect(cleaned).toBe(1);
      expect(store.size).toBe(0);
    });
  });

  describe('size', () => {
    it('should return the number of active contexts', () => {
      expect(store.size).toBe(0);
      store.register('msg-1', 'oc_chat1', { action1: 'prompt1' });
      expect(store.size).toBe(1);
      store.register('msg-2', 'oc_chat2', { action2: 'prompt2' });
      expect(store.size).toBe(2);
      store.unregister('msg-1');
      expect(store.size).toBe(1);
    });
  });

  describe('dispose', () => {
    it('should clear all contexts and stop cleanup timer', () => {
      store.register('msg-1', 'oc_chat1', { action1: 'prompt1' });
      store.register('msg-2', 'oc_chat2', { action2: 'prompt2' });

      store.dispose();
      expect(store.size).toBe(0);
    });
  });
});
