/**
 * InteractiveContextStore Integration Tests.
 *
 * Validates the multi-card coexistence behavior (#1625) with realistic
 * data patterns that simulate actual Feishu card action callbacks.
 *
 * These tests complement the unit tests in interactive-context.test.ts
 * by exercising the full registration → lookup → cross-card search →
 * cleanup lifecycle with data that mirrors production usage.
 *
 * Issue #1626: P0 — InteractiveContextStore multi-card coexistence validation.
 * Issue #1625: IPC sendInteractive card action prompts being overwritten.
 *
 * Run with:
 *   FEISHU_INTEGRATION_TEST=true npx vitest --config vitest.config.feishu.ts tests/integration/feishu/interactive-context.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InteractiveContextStore } from '../../../packages/primary-node/src/interactive-context.js';
import {
  FEISHU_INTEGRATION,
  describeIfFeishu,
  generateTestMarker,
} from './helpers.js';

describe('InteractiveContextStore integration', () => {
  let store: InteractiveContextStore;
  const testMarker = generateTestMarker('ics');

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  /**
   * P0: Multi-card coexistence in the same chat.
   *
   * Simulates the exact scenario from #1625:
   * - IPC script sends Card A with action buttons
   * - Agent sends Card B with confirmation buttons
   * - User clicks Card A's button → should find correct prompt from Card A
   */
  describe('multi-card coexistence (#1625 scenario)', () => {
    it('should resolve action from older card when newer card has different actions', () => {
      // Simulate IPC script sending Card A with AI topic buttons
      const cardAMessageId = `${testMarker}-card-a`;
      const chatId = `${testMarker}-chat`;

      store.register(cardAMessageId, chatId, {
        explain_ai: '[用户操作] 用户想了解AI解释',
        ai_applications: '[用户操作] 用户想看AI应用',
        ai_history: '[用户操作] 用户想看AI历史',
      });

      // Simulate Agent sending Card B with confirmation buttons
      const cardBMessageId = `${testMarker}-card-b`;
      store.register(cardBMessageId, chatId, {
        yes: '[用户操作] 用户确认了',
        no: '[用户操作] 用户拒绝了',
        more_info: '[用户操作] 用户想了解更多',
      });

      // Verify both cards are stored independently
      expect(store.size).toBe(2);

      // Verify exact messageId lookup works for both cards
      const cardAPrompts = store.getActionPrompts(cardAMessageId);
      expect(cardAPrompts).toBeDefined();
      expect(cardAPrompts?.explain_ai).toBe('[用户操作] 用户想了解AI解释');

      const cardBPrompts = store.getActionPrompts(cardBMessageId);
      expect(cardBPrompts).toBeDefined();
      expect(cardBPrompts?.yes).toBe('[用户操作] 用户确认了');

      // Verify chatId fallback returns the most recent card (Card B)
      const chatFallback = store.getActionPromptsByChatId(chatId);
      expect(chatFallback).toEqual(cardBPrompts);

      // Verify cross-card search finds Card A's action even though Card B is newer
      const crossCardResult = store.findActionPromptsByChatId(chatId, 'explain_ai');
      expect(crossCardResult).toEqual(cardAPrompts);

      // Verify cross-card search finds Card B's action
      const crossCardResultB = store.findActionPromptsByChatId(chatId, 'yes');
      expect(crossCardResultB).toEqual(cardBPrompts);
    });

    it('should handle three or more cards in the same chat', () => {
      const chatId = `${testMarker}-multi-chat`;

      // Card 1: Skill selection menu
      store.register(`${testMarker}-card-1`, chatId, {
        skill_a: '用户选择了技能A',
        skill_b: '用户选择了技能B',
      });

      // Card 2: Confirmation dialog
      store.register(`${testMarker}-card-2`, chatId, {
        confirm: '用户确认执行',
        cancel: '用户取消执行',
      });

      // Card 3: Feedback form
      store.register(`${testMarker}-card-3`, chatId, {
        good: '用户评价: 好',
        bad: '用户评价: 差',
        skip: '用户跳过评价',
      });

      expect(store.size).toBe(3);

      // Should find actions from all three cards
      expect(store.findActionPromptsByChatId(chatId, 'skill_a')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'confirm')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'good')).toBeDefined();

      // Latest card (Card 3) should be the chatId fallback
      const latest = store.getActionPromptsByChatId(chatId);
      expect(latest?.good).toBe('用户评价: 好');
    });

    it('should correctly unregister one card without affecting others', () => {
      const chatId = `${testMarker}-unreg-chat`;

      store.register(`${testMarker}-card-x`, chatId, { action_x: 'X' });
      store.register(`${testMarker}-card-y`, chatId, { action_y: 'Y' });
      store.register(`${testMarker}-card-z`, chatId, { action_z: 'Z' });

      // Unregister the middle card
      const removed = store.unregister(`${testMarker}-card-y`);
      expect(removed).toBe(true);
      expect(store.size).toBe(2);

      // Other cards should still work
      expect(store.findActionPromptsByChatId(chatId, 'action_x')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'action_z')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'action_y')).toBeUndefined();
    });
  });

  /**
   * P0: Generate prompt with realistic Feishu callback data.
   *
   * Simulates the exact data format from Feishu card action callbacks,
   * including unknown messageIds and various action types.
   */
  describe('generatePrompt with realistic data', () => {
    it('should generate prompt when messageId differs from registered (Feishu callback pattern)', () => {
      const chatId = `${testMarker}-gen-chat`;

      // Agent registers card with synthetic messageId
      store.register('synthetic-msg-12345', chatId, {
        approve: '[用户操作] 用户选择了「{{actionText}}」',
        reject: '[用户操作] 用户拒绝了操作',
        defer: '[用户操作] 用户选择了稍后处理',
      });

      // Feishu callback comes with a different real messageId
      const prompt = store.generatePrompt(
        'om_xxxxx_real_feishu_msg_id', // Real Feishu messageId (unknown to store)
        chatId,
        'approve',
        '批准' // User-visible button text
      );

      // Should fall back to chatId lookup and find the correct prompt
      expect(prompt).toBe('[用户操作] 用户选择了「批准」');
    });

    it('should handle select_static action type from Feishu dropdown', () => {
      const chatId = `${testMarker}-select-chat`;

      store.register('card-dropdown', chatId, {
        option_a: '用户选择了选项A: {{actionText}} (类型: {{actionType}})',
        option_b: '用户选择了选项B: {{actionText}} (类型: {{actionType}})',
      });

      // Simulate Feishu dropdown selection callback
      const prompt = store.generatePrompt(
        'unknown_dropdown_msg_id',
        chatId,
        'option_a',
        '第一个选项',
        'select_static'
      );

      expect(prompt).toBe('用户选择了选项A: 第一个选项 (类型: select_static)');
    });

    it('should handle form data from Feishu form card', () => {
      const chatId = `${testMarker}-form-chat`;

      store.register('card-form', chatId, {
        submit: '用户提交了反馈: {{form.rating}}/5 - {{form.comment}}',
      });

      const prompt = store.generatePrompt(
        'unknown_form_msg_id',
        chatId,
        'submit',
        undefined,
        undefined,
        { rating: '5', comment: '非常好用！' }
      );

      expect(prompt).toBe('用户提交了反馈: 5/5 - 非常好用！');
    });
  });

  /**
   * P0: LRU eviction behavior with realistic card limits.
   *
   * Verifies that when the per-chat card limit is reached,
   * the oldest cards are evicted and their inverted index entries are cleaned up.
   */
  describe('LRU eviction with cross-card search', () => {
    it('should evict oldest card and remove its inverted index entries', () => {
      const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 3); // Max 3 cards per chat
      const chatId = `${testMarker}-lru-chat`;

      // Register 3 cards (at capacity)
      store.register('card-1', chatId, { old_action: 'Old action prompt' });
      store.register('card-2', chatId, { mid_action: 'Mid action prompt' });
      store.register('card-3', chatId, { new_action: 'New action prompt' });

      expect(store.size).toBe(3);

      // Register a 4th card → should evict card-1
      store.register('card-4', chatId, { latest_action: 'Latest action prompt' });

      expect(store.size).toBe(3);
      expect(store.getActionPrompts('card-1')).toBeUndefined();
      expect(store.findActionPromptsByChatId(chatId, 'old_action')).toBeUndefined();

      // Remaining cards should still be accessible
      expect(store.findActionPromptsByChatId(chatId, 'mid_action')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'new_action')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'latest_action')).toBeDefined();
    });
  });

  /**
   * Feishu API-dependent integration test.
   * Only runs when FEISHU_INTEGRATION_TEST=true.
   *
   * Tests the full flow of registering action prompts with data derived
   * from actual Feishu message formats.
   */
  describeIfFeishu('Feishu API integration', () => {
    it('should store and retrieve prompts using Feishu-compatible IDs', () => {
      // Feishu message IDs follow patterns like:
      // om_xxxxxxxxxxxxxxxx (for messages)
      // ocu_xxxxxxxxxxxxxxxx (for chat IDs)
      const feishuMessageId = `om_${testMarker}`;
      const feishuChatId = `ocu_${testMarker}`;

      store.register(feishuMessageId, feishuChatId, {
        action_confirm: '[用户操作] 确认',
        action_cancel: '[用户操作] 取消',
      });

      // Verify retrieval by exact messageId
      const prompts = store.getActionPrompts(feishuMessageId);
      expect(prompts).toBeDefined();
      expect(prompts?.action_confirm).toBe('[用户操作] 确认');

      // Verify chatId fallback
      const fallback = store.getActionPromptsByChatId(feishuChatId);
      expect(fallback).toEqual(prompts);

      // Verify generatePrompt with Feishu-style callback
      const realFeishuMsgId = 'om_real_callback_id_different_from_registered';
      const prompt = store.generatePrompt(realFeishuMsgId, feishuChatId, 'action_confirm', '确认');
      expect(prompt).toBe('[用户操作] 确认');
    });
  });
});
