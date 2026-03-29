/**
 * P0: InteractiveContextStore multi-card coexistence integration test.
 *
 * Verifies the behavior of InteractiveContextStore when multiple interactive
 * cards exist in the same chat. This tests the chatIdIndex behavior that
 * was identified as problematic in Issue #1625.
 *
 * Key scenarios:
 * - Multiple cards in the same chat should all be independently accessible
 *   via their messageId
 * - The chatIdIndex should track the most recent card
 * - generatePrompt should fall back to chatIdIndex when messageId is unknown
 *
 * Note: This test runs without Feishu connectivity since InteractiveContextStore
 * is a pure in-memory class. However, it is still gated behind
 * FEISHU_INTEGRATION_TEST to keep the integration test suite cohesive.
 *
 * Related: #1626, #1625, #1572
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { describeIfFeishu } from './helpers.js';
import { InteractiveContextStore } from '../../../interactive-context.js';

describeIfFeishu('InteractiveContextStore multi-card coexistence', () => {
  let store: InteractiveContextStore;
  const chatId = 'test-chat-multi-card';

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  describe('multiple cards in the same chat', () => {
    it('should keep all cards independently accessible by messageId', () => {
      // Register 3 cards for the same chat
      store.register('msg-card-1', chatId, {
        action_a: '[Card 1] 用户选择了 A',
      });
      store.register('msg-card-2', chatId, {
        action_b: '[Card 2] 用户选择了 B',
      });
      store.register('msg-card-3', chatId, {
        action_c: '[Card 3] 用户选择了 C',
      });

      expect(store.size).toBe(3);

      // Each card should be independently accessible
      expect(store.getActionPrompts('msg-card-1')).toEqual({
        action_a: '[Card 1] 用户选择了 A',
      });
      expect(store.getActionPrompts('msg-card-2')).toEqual({
        action_b: '[Card 2] 用户选择了 B',
      });
      expect(store.getActionPrompts('msg-card-3')).toEqual({
        action_c: '[Card 3] 用户选择了 C',
      });
    });

    it('should point chatIdIndex to the most recently registered card', () => {
      store.register('msg-card-1', chatId, {
        action_a: '[Card 1] Prompt A',
      });
      store.register('msg-card-2', chatId, {
        action_b: '[Card 2] Prompt B',
      });

      // chatIdIndex should point to the latest (msg-card-2)
      const promptsByChatId = store.getActionPromptsByChatId(chatId);
      expect(promptsByChatId).toEqual({
        action_b: '[Card 2] Prompt B',
      });
    });

    it('should allow generatePrompt to resolve any card by its exact messageId', () => {
      store.register('msg-card-1', chatId, {
        confirm: '[Card 1] 用户确认了',
        cancel: '[Card 1] 用户取消了',
      });
      store.register('msg-card-2', chatId, {
        approve: '[Card 2] 用户批准了',
        reject: '[Card 2] 用户拒绝了',
      });

      // Direct messageId lookup should work for both cards
      const prompt1 = store.generatePrompt('msg-card-1', chatId, 'confirm', '确认');
      expect(prompt1).toBe('[Card 1] 用户确认了');

      const prompt2 = store.generatePrompt('msg-card-2', chatId, 'reject', '拒绝');
      expect(prompt2).toBe('[Card 2] 用户拒绝了');
    });

    it('should fall back to chatIdIndex when real messageId is unknown', () => {
      store.register('msg-synthetic-1', chatId, {
        action_x: '[Fallback] 用户选择了 X',
      });
      store.register('msg-synthetic-2', chatId, {
        action_y: '[Fallback] 用户选择了 Y',
      });

      // Simulate Feishu callback with a real messageId that doesn't match
      // the synthetic messageId used during registration
      const prompt = store.generatePrompt('real-feishu-msg-id', chatId, 'action_y', 'Y');

      // Should fall back to chatIdIndex (msg-synthetic-2, the latest)
      expect(prompt).toBe('[Fallback] 用户选择了 Y');
    });

    it('should still resolve earlier cards by messageId even after newer ones are registered', () => {
      store.register('msg-card-1', chatId, { select: '[Card 1] 选择' });
      store.register('msg-card-2', chatId, { select: '[Card 2] 选择' });

      // Even though chatIdIndex points to card-2, card-1 should still be
      // directly accessible by its messageId
      const prompt = store.generatePrompt('msg-card-1', chatId, 'select');
      expect(prompt).toBe('[Card 1] 选择');
    });
  });

  describe('cross-chat isolation', () => {
    it('should not interfere between different chats', () => {
      store.register('msg-chat-a-1', 'chat-a', {
        action: '[Chat A] 用户操作',
      });
      store.register('msg-chat-b-1', 'chat-b', {
        action: '[Chat B] 用户操作',
      });

      expect(store.getActionPromptsByChatId('chat-a')).toEqual({
        action: '[Chat A] 用户操作',
      });
      expect(store.getActionPromptsByChatId('chat-b')).toEqual({
        action: '[Chat B] 用户操作',
      });
      expect(store.size).toBe(2);
    });

    it('should handle unregister of one card without affecting others in the same chat', () => {
      store.register('msg-card-1', chatId, { a: 'Prompt A' });
      store.register('msg-card-2', chatId, { b: 'Prompt B' });
      store.register('msg-card-3', chatId, { c: 'Prompt C' });

      // Unregister the middle card
      const removed = store.unregister('msg-card-2');
      expect(removed).toBe(true);
      expect(store.size).toBe(2);

      // Other cards should still be accessible
      expect(store.getActionPrompts('msg-card-1')).toEqual({ a: 'Prompt A' });
      expect(store.getActionPrompts('msg-card-3')).toEqual({ c: 'Prompt C' });

      // chatIdIndex should still point to card-3 (latest)
      expect(store.getActionPromptsByChatId(chatId)).toEqual({ c: 'Prompt C' });
    });

    it('should update chatIdIndex when the latest card is unregistered', () => {
      store.register('msg-card-1', chatId, { a: 'Prompt A' });
      store.register('msg-card-2', chatId, { b: 'Prompt B' });

      // Unregister the latest card (card-2)
      store.unregister('msg-card-2');

      // chatIdIndex should be cleaned up (no longer points to card-2)
      // Note: Current implementation does NOT fall back to card-1
      // This is the expected behavior per the current design
      expect(store.getActionPromptsByChatId(chatId)).toBeUndefined();

      // But card-1 should still be directly accessible
      expect(store.getActionPrompts('msg-card-1')).toEqual({ a: 'Prompt A' });
    });
  });

  describe('action prompt template resolution', () => {
    it('should correctly resolve actionPrompts with placeholders across multiple cards', () => {
      store.register('msg-survey', chatId, {
        excellent: '用户评价: ⭐⭐⭐⭐⭐ {{actionText}}',
        good: '用户评价: ⭐⭐⭐⭐ {{actionText}}',
        poor: '用户评价: ⭐⭐ {{actionText}}',
      });
      store.register('msg-feedback', chatId, {
        submit: '用户提交反馈: {{form.comment}}',
        skip: '用户跳过了反馈',
      });

      // Survey card prompt resolution
      expect(store.generatePrompt('msg-survey', chatId, 'excellent', '非常满意')).toBe(
        '用户评价: ⭐⭐⭐⭐⭐ 非常满意'
      );
      expect(store.generatePrompt('msg-survey', chatId, 'poor', '不满意')).toBe(
        '用户评价: ⭐⭐ 不满意'
      );

      // Feedback card prompt resolution with form data
      expect(
        store.generatePrompt('msg-feedback', chatId, 'submit', undefined, undefined, {
          comment: '很棒的产品',
        })
      ).toBe('用户提交反馈: 很棒的产品');
    });
  });

  describe('expiration and cleanup with multiple cards', () => {
    it('should clean up expired cards while preserving non-expired ones', async () => {
      const shortMaxAge = 100; // 100ms
      const store = new InteractiveContextStore(shortMaxAge);

      store.register('msg-old-1', chatId, { a: 'Old A' });
      store.register('msg-old-2', chatId, { b: 'Old B' });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Register a new card
      store.register('msg-new', chatId, { c: 'New C' });

      // Clean up expired
      const cleaned = store.cleanupExpired();
      expect(cleaned).toBe(2);
      expect(store.size).toBe(1);

      // Old cards should be gone
      expect(store.getActionPrompts('msg-old-1')).toBeUndefined();
      expect(store.getActionPrompts('msg-old-2')).toBeUndefined();

      // New card should still be accessible
      expect(store.getActionPrompts('msg-new')).toEqual({ c: 'New C' });
      expect(store.getActionPromptsByChatId(chatId)).toEqual({ c: 'New C' });
    });
  });
});
