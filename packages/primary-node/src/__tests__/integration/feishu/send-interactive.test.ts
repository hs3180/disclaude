/**
 * Feishu Integration Test: IPC sendInteractive End-to-End.
 *
 * Tests the complete sendInteractive flow:
 * 1. Connect to Primary Node via IPC
 * 2. Send interactive card with buttons
 * 3. Verify action prompts registration
 * 4. Test multiple card scenarios
 *
 * Prerequisites:
 * - Primary Node running with Feishu channel configured
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - DISCLAUDE_IPC_SOCKET_PATH set to the running server's socket path
 *
 * Priority: P0
 *
 * @module __tests__/integration/feishu/send-interactive
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  generateTestId,
  TEST_ACTION_PROMPTS,
  TEST_OPTIONS,
} from './helpers.js';

describeIfFeishu('IPC sendInteractive End-to-End', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  const sentMessageIds: string[] = [];

  beforeAll(async () => {
    chatId = getTestChatId();
    const socketPath = getIpcSocketPath();
    client = new UnixSocketIpcClient({ socketPath, timeout: 10000 });
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it('should verify IPC connection is established', async () => {
    const result = await client.ping();
    expect(result).toBe(true);
  });

  it('should send an interactive card with basic options', async () => {
    const testId = generateTestId();
    const result = await client.sendInteractive(chatId, {
      question: `Integration test: basic card (${testId})`,
      options: [
        { text: '✅ 确认', value: 'confirm', type: 'primary' },
        { text: '❌ 取消', value: 'cancel', type: 'danger' },
      ],
      title: '集成测试 - 基础卡片',
      actionPrompts: {
        confirm: '[用户操作] 用户确认了操作',
        cancel: '[用户操作] 用户取消了操作',
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    if (result.messageId) {
      sentMessageIds.push(result.messageId);
    }
  });

  it('should send an interactive card with context section', async () => {
    const testId = generateTestId();
    const result = await client.sendInteractive(chatId, {
      question: `Integration test: card with context (${testId})`,
      options: TEST_OPTIONS as unknown as Array<{
        text: string;
        value: string;
        type?: 'primary' | 'default' | 'danger';
      }>,
      title: '集成测试 - 带上下文卡片',
      context: `Test ID: ${testId}\n此消息由集成测试自动发送，请忽略。`,
      actionPrompts: { ...TEST_ACTION_PROMPTS },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send an interactive card with single option', async () => {
    const testId = generateTestId();
    const result = await client.sendInteractive(chatId, {
      question: `Integration test: single option (${testId})`,
      options: [{ text: '👍 知道了', value: 'ack' }],
      title: '集成测试 - 单按钮',
      actionPrompts: { ack: '[用户操作] 用户已确认收到' },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send multiple interactive cards sequentially', async () => {
    const testId = generateTestId();
    const results = [];

    // Send 3 cards rapidly
    for (let i = 0; i < 3; i++) {
      const result = await client.sendInteractive(chatId, {
        question: `Sequential test ${i + 1}/3 (${testId})`,
        options: [{ text: `Option ${i + 1}`, value: `opt_${i}` }],
        title: `集成测试 - 序列 ${i + 1}`,
        actionPrompts: { [`opt_${i}`]: `[用户操作] 选择了选项 ${i + 1}` },
      });
      results.push(result);
    }

    // Verify all succeeded
    for (let i = 0; i < results.length; i++) {
      expect(results[i].success).toBe(true);
      expect(results[i].messageId).toBeDefined();
    }
  });

  it('should handle interactive card without optional fields', async () => {
    const testId = generateTestId();
    const result = await client.sendInteractive(chatId, {
      question: `Minimal card test (${testId})`,
      options: [
        { text: 'Yes', value: 'yes' },
        { text: 'No', value: 'no' },
      ],
      // No title, context, or actionPrompts
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send card with custom action prompt template', async () => {
    const testId = generateTestId();
    const result = await client.sendInteractive(chatId, {
      question: `Custom prompt template test (${testId})`,
      options: [
        { text: '批准', value: 'approve' },
        { text: '拒绝', value: 'reject' },
      ],
      title: '集成测试 - 自定义提示模板',
      actionPrompts: {
        approve: '[审批结果] 管理员批准了申请，理由: {{actionText}}',
        reject: '[审批结果] 管理员拒绝了申请',
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });
});
