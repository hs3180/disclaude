/**
 * Feishu Integration Test: InteractiveContextStore multi-card coexistence.
 *
 * Validates the #1625 fix (chatIdIndex LRU cache behavior) in an
 * integration context with realistic multi-card scenarios.
 *
 * These tests are **skipped by default**. Enable with:
 *   FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1625 - IPC sendInteractive actionPrompts override bug
 */

import { it, expect, beforeEach, describe } from 'vitest';
import { InteractiveContextStore } from '../../../interactive-context.js';
import {
  logFeishuSkipReason,
  FEISHU_INTEGRATION,
} from './helpers.js';

logFeishuSkipReason();

describe.skipIf(!FEISHU_INTEGRATION)('InteractiveContextStore - Multi-card coexistence (Feishu integration)', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  it('should handle sequential card sends to the same chat without losing older prompts', () => {
    const chatId = 'feishu-chat-001';

    // Simulate: Agent sends Card A with options [confirm, cancel]
    store.register('msg-A', chatId, {
      confirm: '[用户操作] 用户选择了确认',
      cancel: '[用户操作] 用户选择了取消',
    });

    // Simulate: Agent sends Card B with options [yes, no] (same chat)
    store.register('msg-B', chatId, {
      yes: '[用户操作] 用户选择了是',
      no: '[用户操作] 用户选择了否',
    });

    // Verify: Both cards' contexts exist
    expect(store.getActionPrompts('msg-A')).toBeDefined();
    expect(store.getActionPrompts('msg-B')).toBeDefined();
    expect(store.size).toBe(2);
  });

  it('should find correct actionPrompts via chatId fallback for older cards', () => {
    const chatId = 'feishu-chat-002';

    // Send Card A
    store.register('msg-A', chatId, {
      deploy: '[用户操作] 用户选择了部署',
      rollback: '[用户操作] 用户选择了回滚',
    });

    // Send Card B (same chat, overwrites chatId index)
    store.register('msg-B', chatId, {
      approve: '[用户操作] 用户选择了批准',
      reject: '[用户操作] 用户选择了拒绝',
    });

    // Direct messageId lookup still works for both
    const promptsA = store.getActionPrompts('msg-A');
    expect(promptsA).toEqual({
      deploy: '[用户操作] 用户选择了部署',
      rollback: '[用户操作] 用户选择了回滚',
    });

    const promptsB = store.getActionPrompts('msg-B');
    expect(promptsB).toEqual({
      approve: '[用户操作] 用户选择了批准',
      reject: '[用户操作] 用户选择了拒绝',
    });
  });

  it('should document known limitation: chatId fallback misses older card actions', () => {
    const chatId = 'feishu-chat-003';

    // Send Card A with Chinese template
    store.register('msg-A', chatId, {
      option1: '[用户操作] 用户选择了「{{actionText}}」',
      option2: '[用户操作] 用户选择了「{{actionText}}」',
    });

    // Send Card B (newer, different options) — overwrites chatId index
    store.register('msg-B', chatId, {
      next: '[用户操作] 用户选择了下一步',
    });

    // Simulate Feishu callback for Card A (real messageId differs from synthetic)
    // The chatId fallback finds Card B's prompts, but actionValue 'option1'
    // only exists in Card A → returns undefined.
    //
    // This is the known limitation that PR #1687 fixes with array-based
    // chatIdIndex and findPromptsByChatIdAndAction().
    const prompt = store.generatePrompt('real-feishu-msg-A', chatId, 'option1', '选项一');

    // Current behavior: returns undefined (known limitation)
    expect(prompt).toBeUndefined();

    // After PR #1687 merges, update this to expect the correct prompt:
    // expect(prompt).toBe('[用户操作] 用户选择了「选项一」');
  });

  it('should handle concurrent multi-chat scenarios', () => {
    const chat1 = 'feishu-group-001';
    const chat2 = 'feishu-group-002';
    const chat3 = 'p2p-chat-user-001';

    // Different chats get different cards
    store.register('msg-1', chat1, {
      start: '[用户操作] 启动任务',
      stop: '[用户操作] 停止任务',
    });

    store.register('msg-2', chat2, {
      approve: '[用户操作] 批准',
      reject: '[用户操作] 拒绝',
    });

    store.register('msg-3', chat3, {
      reply: '[用户操作] 用户选择了回复',
    });

    expect(store.size).toBe(3);

    // Each chat's fallback should return the correct card
    const prompts1 = store.getActionPromptsByChatId(chat1);
    expect(prompts1).toEqual({
      start: '[用户操作] 启动任务',
      stop: '[用户操作] 停止任务',
    });

    const prompts2 = store.getActionPromptsByChatId(chat2);
    expect(prompts2).toEqual({
      approve: '[用户操作] 批准',
      reject: '[用户操作] 拒绝',
    });

    const prompts3 = store.getActionPromptsByChatId(chat3);
    expect(prompts3).toEqual({
      reply: '[用户操作] 用户选择了回复',
    });
  });

  it('should handle cleanup without affecting other chats', () => {
    const chat1 = 'feishu-group-001';
    const chat2 = 'feishu-group-002';

    store.register('msg-1', chat1, { action: 'prompt-1' });
    store.register('msg-2', chat2, { action: 'prompt-2' });

    // Unregister msg-1 from chat1
    store.unregister('msg-1');

    expect(store.size).toBe(1);
    expect(store.getActionPrompts('msg-2')).toBeDefined();
    expect(store.getActionPromptsByChatId(chat2)).toBeDefined();
    expect(store.getActionPromptsByChatId(chat1)).toBeUndefined();
  });

  it('should handle realistic Feishu action callback format', () => {
    const chatId = 'oc_test_chat_id';

    store.register('synthetic-msg-id', chatId, {
      approve_pr: '[用户操作] 用户选择了批准 PR',
      request_changes: '[用户操作] 用户选择了请求修改',
      add_comment: '[用户操作] 用户选择了添加评论',
      view_diff: '[用户操作] 用户选择了查看差异',
    });

    // Simulate Feishu card action callback
    // Feishu sends the real message_id which differs from our synthetic ID
    const realFeishuMsgId = 'om_real_feishu_message_id';
    const prompt = store.generatePrompt(realFeishuMsgId, chatId, 'approve_pr', '批准 PR');

    // Should fall back to chatId lookup
    expect(prompt).toBe('[用户操作] 用户选择了批准 PR');
  });

  it('should handle template placeholders correctly for Feishu card actions', () => {
    const chatId = 'oc_template_test';

    store.register('msg-tpl', chatId, {
      select_option: '[用户操作] 用户选择了「{{actionText}}」',
      select_value: '用户选择了 {{actionValue}}',
      submit_form: '表单提交: 名称={{form.name}}, 类型={{form.type}}',
      mixed: '{{actionText}} 触发了 {{actionValue}} (类型: {{actionType}})',
    });

    // Test actionText replacement
    expect(store.generatePrompt('msg-tpl', chatId, 'select_option', '创建分支'))
      .toBe('[用户操作] 用户选择了「创建分支」');

    // Test actionValue replacement
    expect(store.generatePrompt('msg-tpl', chatId, 'select_value'))
      .toBe('用户选择了 select_value');

    // Test form data replacement
    expect(store.generatePrompt('msg-tpl', chatId, 'submit_form', undefined, undefined, {
      name: '测试',
      type: 'bugfix',
    }))
      .toBe('表单提交: 名称=测试, 类型=bugfix');

    // Test mixed placeholders
    expect(store.generatePrompt('msg-tpl', chatId, 'mixed', '部署', 'button'))
      .toBe('部署 触发了 mixed (类型: button)');
  });
});
