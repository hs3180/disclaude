/**
 * InteractiveContextStore integration test.
 *
 * Tests multi-card coexistence behavior after #1625 fix.
 * Verifies that registering multiple cards in the same chat
 * does not cause actionPrompts overwrite.
 *
 * Tier 1: No Feishu credentials required.
 *
 * @module __tests__/integration/feishu/interactive-context
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1625 - actionPrompts overwrite fix
 */

import { it, expect, beforeEach } from 'vitest';
import { InteractiveContextStore } from '../../../interactive-context.js';
import { describeIfFeishu, generateTestMarker } from './helpers.js';

describeIfFeishu('InteractiveContextStore multi-card coexistence (#1625)', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  it('should preserve actionPrompts for all registered cards', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    // Register 3 cards in the same chat
    store.register('msg_1', chatId, { a1: 'Prompt A1', a2: 'Prompt A2' });
    store.register('msg_2', chatId, { b1: 'Prompt B1' });
    store.register('msg_3', chatId, {
      c1: 'Prompt C1',
      c2: 'Prompt C2',
      c3: 'Prompt C3',
    });

    // All cards should be accessible by messageId
    expect(store.getActionPrompts('msg_1')).toEqual({
      a1: 'Prompt A1',
      a2: 'Prompt A2',
    });
    expect(store.getActionPrompts('msg_2')).toEqual({ b1: 'Prompt B1' });
    expect(store.getActionPrompts('msg_3')).toEqual({
      c1: 'Prompt C1',
      c2: 'Prompt C2',
      c3: 'Prompt C3',
    });

    // chatId fallback should return the latest card
    expect(store.getActionPromptsByChatId(chatId)).toEqual({
      c1: 'Prompt C1',
      c2: 'Prompt C2',
      c3: 'Prompt C3',
    });
  });

  it('should generate correct prompts for each card independently', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    store.register('card_approval', chatId, {
      approve: '[审批] 用户批准了，备注: {{form.note}}',
      reject: '[审批] 用户拒绝了，原因: {{form.reason}}',
    });
    store.register('card_rating', chatId, {
      good: '[评分] 用户给出了好评',
      bad: '[评分] 用户给出了差评',
    });

    // Each card should generate its own prompt correctly
    const approvalPrompt = store.generatePrompt(
      'card_approval',
      chatId,
      'approve',
      '批准',
      'button',
      { note: '同意' }
    );
    expect(approvalPrompt).toBe('[审批] 用户批准了，备注: 同意');

    const ratingPrompt = store.generatePrompt(
      'card_rating',
      chatId,
      'bad',
      '差评',
      'button'
    );
    expect(ratingPrompt).toBe('[评分] 用户给出了差评');
  });

  it('should handle unregistering a card without affecting others', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    store.register('msg_1', chatId, { a: 'Prompt A' });
    store.register('msg_2', chatId, { b: 'Prompt B' });
    store.register('msg_3', chatId, { c: 'Prompt C' });

    // Unregister middle card
    const removed = store.unregister('msg_2');
    expect(removed).toBe(true);

    // Other cards should be unaffected
    expect(store.getActionPrompts('msg_1')).toEqual({ a: 'Prompt A' });
    expect(store.getActionPrompts('msg_2')).toBeUndefined();
    expect(store.getActionPrompts('msg_3')).toEqual({ c: 'Prompt C' });

    // chatId fallback should still return latest
    expect(store.getActionPromptsByChatId(chatId)).toEqual({ c: 'Prompt C' });
  });

  it('should update chatId index when latest card is unregistered', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    store.register('msg_1', chatId, { a: 'Prompt A' });
    store.register('msg_2', chatId, { b: 'Prompt B' });

    // Unregister latest card
    store.unregister('msg_2');

    // chatId index should be cleaned up (not pointing to stale entry)
    const fallback = store.getActionPromptsByChatId(chatId);
    expect(fallback).toBeUndefined();

    // But msg_1 should still be accessible by messageId
    expect(store.getActionPrompts('msg_1')).toEqual({ a: 'Prompt A' });
  });

  it('should handle multiple chats independently', () => {
    const chat1 = `oc_chat1_${generateTestMarker()}`;
    const chat2 = `oc_chat2_${generateTestMarker()}`;

    store.register('msg_1', chat1, { a: 'Chat1 Prompt A' });
    store.register('msg_2', chat2, { b: 'Chat2 Prompt B' });

    expect(store.getActionPromptsByChatId(chat1)).toEqual({
      a: 'Chat1 Prompt A',
    });
    expect(store.getActionPromptsByChatId(chat2)).toEqual({
      b: 'Chat2 Prompt B',
    });
  });

  it('should replace template placeholders correctly', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    store.register('msg_template', chatId, {
      action: '用户 {{actionText}} 操作了 {{actionValue}} (类型: {{actionType}})',
    });

    const prompt = store.generatePrompt(
      'msg_template',
      chatId,
      'action',
      '删除',
      'button'
    );
    expect(prompt).toBe('用户 删除 操作了 action (类型: button)');
  });

  it('should handle missing placeholders gracefully', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    store.register('msg_partial', chatId, {
      action: '用户 {{actionText}} 执行了操作',
    });

    // actionType not in template - should not appear
    const prompt = store.generatePrompt(
      'msg_partial',
      chatId,
      'action',
      '确认'
    );
    expect(prompt).toBe('用户 确认 执行了操作');
  });

  it('should return undefined for non-existent messageId', () => {
    expect(store.getActionPrompts('non_existent')).toBeUndefined();
    expect(
      store.generatePrompt('non_existent', 'chat', 'action')
    ).toBeUndefined();
  });

  it('should return undefined for non-existent chatId', () => {
    expect(store.getActionPromptsByChatId('non_existent_chat')).toBeUndefined();
  });

  it('should report correct size', () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    expect(store.size).toBe(0);

    store.register('msg_1', chatId, { a: 'A' });
    expect(store.size).toBe(1);

    store.register('msg_2', chatId, { b: 'B' });
    expect(store.size).toBe(2);

    store.unregister('msg_1');
    expect(store.size).toBe(1);

    store.clear();
    expect(store.size).toBe(0);
  });
});
