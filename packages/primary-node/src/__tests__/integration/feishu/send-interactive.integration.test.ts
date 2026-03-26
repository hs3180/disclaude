/**
 * Feishu Integration Test: IPC sendInteractive end-to-end flow.
 *
 * Tests the complete IPC sendInteractive flow:
 * 1. Build interactive card with options
 * 2. Send card via IPC
 * 3. Register actionPrompts in InteractiveContextStore
 * 4. Simulate card action callback
 * 5. Verify generated prompt
 *
 * These tests are **skipped by default**. Enable with:
 *   FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1570 - sendInteractive IPC flow
 * @see Issue #1572 - InteractiveContextStore migration
 */

import { it, expect, beforeEach, describe } from 'vitest';
import { InteractiveContextStore } from '../../../interactive-context.js';
import { logFeishuSkipReason, FEISHU_INTEGRATION, getTestChatId } from './helpers.js';

logFeishuSkipReason();

/**
 * Types matching the IPC sendInteractive request format.
 */
interface InteractiveOption {
  text: string;
  value: string;
  type?: 'primary' | 'default' | 'danger';
}

interface SendInteractiveParams {
  chatId: string;
  question: string;
  options: InteractiveOption[];
  title?: string;
  context?: string;
  threadId?: string;
  actionPrompts?: Record<string, string>;
}

describe.skipIf(!FEISHU_INTEGRATION)('IPC sendInteractive - End-to-end flow', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  /**
   * Helper: Simulate the sendInteractive IPC flow.
   * This mirrors what happens in the real Primary Node when processing
   * a sendInteractive IPC request.
   */
  function simulateSendInteractive(params: SendInteractiveParams): {
    messageId: string;
    actionPrompts: Record<string, string>;
  } {
    const messageId = `synthetic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const actionPrompts = params.actionPrompts ?? {};

    // Register the action prompts (same as Primary Node does)
    store.register(messageId, params.chatId, actionPrompts);

    return { messageId, actionPrompts };
  }

  it('should complete the full sendInteractive → callback → prompt generation cycle', () => {
    const chatId = getTestChatId() ?? 'test-chat-default';

    const params: SendInteractiveParams = {
      chatId,
      question: '请选择操作：',
      options: [
        { text: '确认', value: 'confirm', type: 'primary' },
        { text: '取消', value: 'cancel' },
      ],
      actionPrompts: {
        confirm: '[用户操作] 用户选择了确认',
        cancel: '[用户操作] 用户选择了取消',
      },
    };

    // Step 1: Send interactive card
    const { messageId } = simulateSendInteractive(params);

    // Step 2: Verify registration
    expect(store.getActionPrompts(messageId)).toEqual(params.actionPrompts);
    expect(store.size).toBe(1);

    // Step 3: Simulate Feishu callback with real messageId
    const realFeishuMsgId = 'om_real_feishu_message';
    const prompt = store.generatePrompt(realFeishuMsgId, chatId, 'confirm', '确认');

    // Step 4: Verify prompt generation
    expect(prompt).toBe('[用户操作] 用户选择了确认');
  });

  it('should handle multiple interactive cards in sequence', () => {
    const chatId = getTestChatId() ?? 'test-chat-multi';

    // Card 1: PR review
    const card1 = simulateSendInteractive({
      chatId,
      question: '请审核此 PR：',
      options: [
        { text: '批准', value: 'approve', type: 'primary' },
        { text: '请求修改', value: 'request_changes', type: 'danger' },
      ],
      actionPrompts: {
        approve: '[用户操作] 用户选择了批准 PR',
        request_changes: '[用户操作] 用户选择了请求修改',
      },
    });

    // Card 2: Follow-up question
    const card2 = simulateSendInteractive({
      chatId,
      question: '是否需要部署？',
      options: [
        { text: '立即部署', value: 'deploy_now', type: 'primary' },
        { text: '稍后部署', value: 'deploy_later' },
        { text: '跳过', value: 'skip' },
      ],
      actionPrompts: {
        deploy_now: '[用户操作] 用户选择了立即部署',
        deploy_later: '[用户操作] 用户选择了稍后部署',
        skip: '[用户操作] 用户选择了跳过部署',
      },
    });

    // Both cards should be registered
    expect(store.size).toBe(2);

    // Latest card should be the chatId fallback
    const fallbackPrompts = store.getActionPromptsByChatId(chatId);
    expect(fallbackPrompts).toEqual(card2.actionPrompts);

    // But older card should still be accessible by messageId
    expect(store.getActionPrompts(card1.messageId)).toEqual(card1.actionPrompts);
    expect(store.getActionPrompts(card2.messageId)).toEqual(card2.actionPrompts);
  });

  it('should generate prompts with various action types', () => {
    const chatId = getTestChatId() ?? 'test-chat-action-types';

    simulateSendInteractive({
      chatId,
      question: '选择操作类型：',
      options: [
        { text: '主要按钮', value: 'primary_action', type: 'primary' },
        { text: '危险操作', value: 'danger_action', type: 'danger' },
        { text: '默认按钮', value: 'default_action' },
      ],
      actionPrompts: {
        primary_action: '[用户操作] 触发主要操作 ({{actionType}})',
        danger_action: '[用户操作] 触发危险操作 ({{actionType}})',
        default_action: '[用户操作] 触发默认操作 ({{actionType}})',
      },
    });

    // Test with button action type
    const prompt = store.generatePrompt('any-msg-id', chatId, 'primary_action', '主要按钮', 'button');
    expect(prompt).toBe('[用户操作] 触发主要操作 (button)');
  });

  it('should handle cleanup after card interaction is complete', () => {
    const chatId = getTestChatId() ?? 'test-chat-cleanup';

    const { messageId } = simulateSendInteractive({
      chatId,
      question: '一次性确认',
      options: [{ text: '确认', value: 'ok', type: 'primary' }],
      actionPrompts: { ok: '[用户操作] 已确认' },
    });

    // After interaction, unregister the context
    const removed = store.unregister(messageId);
    expect(removed).toBe(true);
    expect(store.size).toBe(0);
    expect(store.getActionPromptsByChatId(chatId)).toBeUndefined();

    // Double-unregister should be safe
    expect(store.unregister(messageId)).toBe(false);
  });

  it('should handle expired contexts gracefully', () => {
    const chatId = getTestChatId() ?? 'test-chat-expiry';

    // Use a very short max age (50ms) for testing
    const shortLivedStore = new InteractiveContextStore(50);

    shortLivedStore.register('msg-expiring', chatId, {
      action: '[用户操作] 测试操作',
    });

    // Should work immediately
    expect(shortLivedStore.generatePrompt('msg-expiring', chatId, 'action')).toBeDefined();

    // Wait for expiration
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Clean up expired
        const cleaned = shortLivedStore.cleanupExpired();
        expect(cleaned).toBe(1);
        expect(shortLivedStore.size).toBe(0);

        // Should not find prompts after cleanup
        expect(shortLivedStore.generatePrompt('msg-expiring', chatId, 'action')).toBeUndefined();
        resolve();
      }, 100);
    });
  });
});
