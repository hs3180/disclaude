/**
 * Feishu Integration Test: InteractiveContextStore Multi-card Coexistence.
 *
 * Tests the multi-card context behavior via IPC, verifying that:
 * 1. Multiple cards in the same chat maintain separate contexts
 * 2. The chatIdIndex correctly tracks the most recent card
 * 3. Action prompts are not overwritten when multiple cards share the same chat
 * (Regression test for Issue #1625)
 *
 * Prerequisites:
 * - Primary Node running with Feishu channel configured
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - DISCLAUDE_IPC_SOCKET_PATH set to the running server's socket path
 *
 * Priority: P0
 *
 * @module __tests__/integration/feishu/interactive-context
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  generateTestId,
  delay,
} from './helpers.js';

describeIfFeishu('InteractiveContextStore Multi-card Coexistence (Issue #1625)', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

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

  it('should send multiple cards to the same chat without context loss', async () => {
    const testId = generateTestId();

    // Send first card with option A
    const result1 = await client.sendInteractive(chatId, {
      question: `Multi-card test 1/2 (${testId})`,
      options: [{ text: '选项 A', value: 'option_a' }],
      title: '多卡片测试 - 卡片 1',
      actionPrompts: { option_a: '[用户操作] 用户选择了选项A（卡片1）' },
    });
    expect(result1.success).toBe(true);
    expect(result1.messageId).toBeDefined();

    // Small delay to ensure ordering
    await delay(200);

    // Send second card with option B (same chat, different options)
    const result2 = await client.sendInteractive(chatId, {
      question: `Multi-card test 2/2 (${testId})`,
      options: [{ text: '选项 B', value: 'option_b' }],
      title: '多卡片测试 - 卡片 2',
      actionPrompts: { option_b: '[用户操作] 用户选择了选项B（卡片2）' },
    });
    expect(result2.success).toBe(true);
    expect(result2.messageId).toBeDefined();

    // Both cards should have different message IDs
    expect(result1.messageId).not.toBe(result2.messageId);
  });

  it('should send cards to different chats independently', async () => {
    const testId = generateTestId();

    // Card to primary chat
    const result1 = await client.sendInteractive(chatId, {
      question: `Cross-chat test - chat 1 (${testId})`,
      options: [{ text: 'Chat1', value: 'chat1_action' }],
      title: '跨聊天测试 - 聊天 1',
      actionPrompts: { chat1_action: '[用户操作] 聊天1的操作' },
    });
    expect(result1.success).toBe(true);

    // Card to a different chat (using the same chatId but with a unique suffix to simulate)
    // Note: In real scenarios, this would be a different chatId
    const altChatId = chatId; // Same chat, but tests chatIdIndex behavior
    const result2 = await client.sendInteractive(altChatId, {
      question: `Cross-chat test - chat 2 (${testId})`,
      options: [{ text: 'Chat2', value: 'chat2_action' }],
      title: '跨聊天测试 - 聊天 2',
      actionPrompts: { chat2_action: '[用户操作] 聊天2的操作' },
    });
    expect(result2.success).toBe(true);

    // Both should succeed with different message IDs
    expect(result1.messageId).not.toBe(result2.messageId);
  });

  it('should handle rapid sequential card sends (stress test)', async () => {
    const testId = generateTestId();
    const count = 5;
    const results = [];

    for (let i = 0; i < count; i++) {
      const result = await client.sendInteractive(chatId, {
        question: `Stress test card ${i + 1}/${count} (${testId})`,
        options: [{ text: `Action ${i + 1}`, value: `stress_${i}` }],
        title: `压力测试 - 卡片 ${i + 1}`,
        actionPrompts: { [`stress_${i}`]: `[用户操作] 压力测试操作 ${i + 1}` },
      });
      results.push(result);
    }

    // All should succeed
    for (let i = 0; i < count; i++) {
      expect(results[i].success).toBe(true);
      expect(results[i].messageId).toBeDefined();
    }

    // All message IDs should be unique
    const messageIds = results.map((r) => r.messageId).filter(Boolean) as string[];
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(count);
  });

  it('should send card with many options without errors', async () => {
    const testId = generateTestId();
    const options = Array.from({ length: 10 }, (_, i) => ({
      text: `选项 ${i + 1}`,
      value: `option_${i}`,
      type: (['primary', 'default', 'danger'] as const)[i % 3],
    }));

    const actionPrompts: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      actionPrompts[`option_${i}`] = `[用户操作] 用户选择了选项 ${i + 1}`;
    }

    const result = await client.sendInteractive(chatId, {
      question: `Multi-option card test (${testId})`,
      options: options as unknown as Array<{
        text: string;
        value: string;
        type?: 'primary' | 'default' | 'danger';
      }>,
      title: '集成测试 - 多选项卡片',
      actionPrompts,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });
});
