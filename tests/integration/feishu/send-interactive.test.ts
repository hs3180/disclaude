/**
 * Integration tests for IPC sendInteractive end-to-end flow.
 *
 * Tests the complete chain: IPC request → card sending → actionPrompts registration.
 *
 * Prerequisites:
 *   - Primary Node must be running with IPC enabled
 *   - FEISHU_INTEGRATION_TEST=true
 *   - FEISHU_TEST_CHAT_ID set to a valid chat where the bot is a member
 *
 * @see Issue #1626 - Feishu integration test framework
 * @see Issue #1570 - IPC sendInteractive flow
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getTestSocketPath,
  assertIpcSuccess,
} from './helpers.js';

describeIfFeishu('IPC sendInteractive end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    chatId = getTestChatId();
    client = new UnixSocketIpcClient({
      socketPath: getTestSocketPath(),
      timeout: 15000,
    });
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  it('should verify IPC server connectivity via ping', async () => {
    const isAlive = await client.ping();
    expect(isAlive).toBe(true);
  });

  it('should send an interactive card and receive messageId', async () => {
    const result = await client.sendInteractive(chatId, {
      question: 'Integration Test: 请选择一个选项',
      options: [
        { text: '选项 A', value: 'option_a' },
        { text: '选项 B', value: 'option_b' },
      ],
      title: '集成测试卡片',
      context: 'feishu-integration-test',
      actionPrompts: {
        option_a: '[用户操作] 用户选择了选项A',
        option_b: '[用户操作] 用户选择了选项B',
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId!.length).toBeGreaterThan(0);
  });

  it('should send an interactive card with primary button type', async () => {
    const result = await client.sendInteractive(chatId, {
      question: 'Integration Test: 确认操作',
      options: [
        { text: '确认', value: 'confirm', type: 'primary' },
        { text: '取消', value: 'cancel', type: 'danger' },
      ],
      actionPrompts: {
        confirm: '[用户操作] 用户确认了操作',
        cancel: '[用户操作] 用户取消了操作',
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send an interactive card with threadId', async () => {
    const result = await client.sendInteractive(chatId, {
      question: 'Integration Test: 回复测试',
      options: [
        { text: '回复', value: 'reply' },
      ],
      threadId: 'test-thread-id',
      actionPrompts: {
        reply: '[用户操作] 用户回复了测试',
      },
    });

    expect(result.success).toBe(true);
  });

  it('should fail gracefully with invalid chatId', async () => {
    const result = await client.sendInteractive('oc_invalid_chat_id_12345', {
      question: 'This should fail',
      options: [{ text: 'A', value: 'a' }],
    });

    // Should not throw - IPC layer should handle the error gracefully
    expect(result).toBeDefined();
    // The IPC call itself succeeds (message sent to Primary Node),
    // but the actual Feishu API call may fail
    // We just verify no crash occurs
  });
});
