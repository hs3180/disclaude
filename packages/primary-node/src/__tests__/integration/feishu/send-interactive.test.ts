/**
 * IPC sendInteractive complete flow integration test.
 *
 * Tests the full chain: Card send -> actionPrompts registration -> callback verification.
 *
 * Tier 1: No Feishu credentials required (uses mock handlers + real InteractiveContextStore).
 *
 * @module __tests__/integration/feishu/send-interactive
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1570 - sendInteractive IPC flow
 * @see Issue #1625 - actionPrompts overwrite fix
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
} from '@disclaude/core';
import { InteractiveContextStore } from '../../../interactive-context.js';
import {
  describeIfFeishu,
  generateTestMarker,
} from './helpers.js';

describeIfFeishu('IPC sendInteractive complete flow', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let contextStore: InteractiveContextStore;
  const registeredContexts: Array<{
    messageId: string;
    chatId: string;
    actionPrompts: Record<string, string>;
  }> = [];

  function generateSocketPath(): string {
    return join(
      tmpdir(),
      `feishu-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
    );
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    contextStore = new InteractiveContextStore();
    registeredContexts.length = 0;

    // Create IPC handler with real InteractiveContextStore
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        contextStore.register(messageId, chatId, actionPrompts);
        registeredContexts.push({ messageId, chatId, actionPrompts });
      },
      {
        handlers: {
          sendMessage: async () => {},
          sendCard: async () => {},
          uploadFile: async () => ({
            fileKey: '',
            fileType: 'file',
            fileName: 'f',
            fileSize: 0,
          }),
          sendInteractive: async (_chatId, params) => {
            const syntheticId = `om_${params.options[0]?.value}_${Date.now()}`;
            // Mimic real handler behavior: auto-generate actionPrompts if not provided
            const actionPrompts =
              params.actionPrompts && Object.keys(params.actionPrompts).length > 0
                ? params.actionPrompts
                : Object.fromEntries(
                    params.options.map((opt) => [
                      opt.value,
                      `[用户操作] 用户选择了${opt.text}`,
                    ])
                  );
            return { messageId: syntheticId, actionPrompts };
          },
        },
      }
    );

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    contextStore.clear();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  });

  it('should send interactive card and register actionPrompts', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const actionPrompts = {
      confirm: '[用户操作] 用户确认了操作',
      cancel: '[用户操作] 用户取消了操作',
    };

    const result = await client.sendInteractive(chatId, {
      question: '请确认是否继续？',
      options: [
        { text: '确认', value: 'confirm', type: 'primary' },
        { text: '取消', value: 'cancel' },
      ],
      title: '操作确认',
      actionPrompts,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();

    // Verify actionPrompts were registered in InteractiveContextStore
    expect(registeredContexts).toHaveLength(1);
    expect(registeredContexts[0].actionPrompts).toEqual(actionPrompts);

    // Verify lookup by messageId
    const prompts = contextStore.getActionPrompts(result.messageId!);
    expect(prompts).toEqual(actionPrompts);
  });

  it('should generate correct prompt from card action callback', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const actionPrompts = {
      approve: '[用户操作] 用户批准了申请，金额: {{form.amount}}',
      reject: '[用户操作] 用户拒绝了申请',
    };

    const result = await client.sendInteractive(chatId, {
      question: '请审批此申请',
      options: [
        { text: '批准', value: 'approve', type: 'primary' },
        { text: '拒绝', value: 'reject', type: 'danger' },
      ],
      actionPrompts,
    });

    // Simulate card action callback
    const prompt = contextStore.generatePrompt(
      result.messageId!,
      chatId,
      'approve',
      '批准',
      'button',
      { amount: '100元' }
    );

    expect(prompt).toBe('[用户操作] 用户批准了申请，金额: 100元');
  });

  it('should fall back to chatId lookup when messageId mismatches', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const actionPrompts = {
      option1: '[用户操作] 用户选择了选项1',
    };

    await client.sendInteractive(chatId, {
      question: '选择一个选项',
      options: [{ text: '选项1', value: 'option1' }],
      actionPrompts,
    });

    // Simulate Feishu callback with a different messageId
    // (happens when real Feishu messageId doesn't match the synthetic one)
    const realFeishuMessageId = 'om_real_feishu_id';
    const prompt = contextStore.generatePrompt(
      realFeishuMessageId,
      chatId,
      'option1',
      '选项1'
    );

    expect(prompt).toBe('[用户操作] 用户选择了选项1');
  });

  it('should handle multiple cards in the same chat (#1625)', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    // Send first card
    const result1 = await client.sendInteractive(chatId, {
      question: '第一个问题',
      options: [{ text: 'A', value: 'a' }],
      actionPrompts: { a: '[用户操作] 用户选择了A（第一个卡片）' },
    });

    // Send second card (should NOT overwrite first card's actionPrompts)
    const result2 = await client.sendInteractive(chatId, {
      question: '第二个问题',
      options: [{ text: 'B', value: 'b' }],
      actionPrompts: { b: '[用户操作] 用户选择了B（第二个卡片）' },
    });

    // Both cards should have their actionPrompts registered
    expect(registeredContexts).toHaveLength(2);

    // First card should still be accessible by messageId
    const prompts1 = contextStore.getActionPrompts(result1.messageId!);
    expect(prompts1).toEqual({ a: '[用户操作] 用户选择了A（第一个卡片）' });

    // Second card should also be accessible
    const prompts2 = contextStore.getActionPrompts(result2.messageId!);
    expect(prompts2).toEqual({ b: '[用户操作] 用户选择了B（第二个卡片）' });

    // chatId fallback should return the latest card's prompts
    const fallbackPrompts = contextStore.getActionPromptsByChatId(chatId);
    expect(fallbackPrompts).toEqual({
      b: '[用户操作] 用户选择了B（第二个卡片）',
    });
  });

  it('should handle card with no actionPrompts (auto-generated)', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    const result = await client.sendInteractive(chatId, {
      question: '选择颜色',
      options: [
        { text: '红色', value: 'red' },
        { text: '蓝色', value: 'blue' },
      ],
    });

    expect(result.success).toBe(true);
    // Should still register (with auto-generated or empty prompts)
    expect(registeredContexts).toHaveLength(1);
  });

  it('should handle card action with formData placeholders', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const actionPrompts = {
      submit: '[表单提交] 用户提交了表单: 名称={{form.name}}, 邮箱={{form.email}}',
    };

    const result = await client.sendInteractive(chatId, {
      question: '请填写信息',
      options: [{ text: '提交', value: 'submit', type: 'primary' }],
      actionPrompts,
    });

    const prompt = contextStore.generatePrompt(
      result.messageId!,
      chatId,
      'submit',
      '提交',
      'button',
      { name: '张三', email: 'zhangsan@example.com' }
    );

    expect(prompt).toBe(
      '[表单提交] 用户提交了表单: 名称=张三, 邮箱=zhangsan@example.com'
    );
  });
});
