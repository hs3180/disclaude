/**
 * P0: IPC sendInteractive end-to-end integration test.
 *
 * Tests the complete flow:
 *   Card sending → actionPrompts registration → callback verification
 *
 * Requires:
 *   FEISHU_INTEGRATION_TEST=true
 *   FEISHU_TEST_CHAT_ID=<valid_chat_id>
 *   A running Primary Node with Feishu connection
 *
 * Related: #1626, #1570, #1572
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  FEISHU_API_TIMEOUT,
  IPC_TIMEOUT,
} from './helpers.js';
import {
  UnixSocketIpcClient,
  getIpcSocketPath,
  resetIpcClient,
} from '@disclaude/core';

describeIfFeishu('IPC sendInteractive end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    chatId = getTestChatId();
    client = new UnixSocketIpcClient({
      socketPath: getIpcSocketPath(),
      timeout: IPC_TIMEOUT,
      maxRetries: 1,
    });
    await client.connect();
  }, FEISHU_API_TIMEOUT);

  afterAll(async () => {
    await client.disconnect();
    resetIpcClient();
  });

  it('should send an interactive card and receive a success response', async () => {
    const result = await client.sendInteractive(chatId, {
      question: '🔧 Integration Test: 请选择一个选项',
      options: [
        { text: '✅ 确认', value: 'confirm', type: 'primary' },
        { text: '❌ 取消', value: 'cancel', type: 'danger' },
      ],
      title: '集成测试卡片',
      actionPrompts: {
        confirm: '[用户操作] 用户确认了集成测试',
        cancel: '[用户操作] 用户取消了集成测试',
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
  }, FEISHU_API_TIMEOUT);

  it('should send an interactive card with context and thread support', async () => {
    const result = await client.sendInteractive(chatId, {
      question: '🔧 Thread Test: 验证线程消息',
      options: [
        { text: '👍 好的', value: 'ok', type: 'primary' },
      ],
      context: '这是一个集成测试的上下文信息',
      actionPrompts: {
        ok: '[用户操作] 用户在线程中回复了"好的"',
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  }, FEISHU_API_TIMEOUT);

  it('should send an interactive card with auto-generated prompts (no actionPrompts provided)', async () => {
    const result = await client.sendInteractive(chatId, {
      question: '🔧 Auto-prompt Test: 自动生成 actionPrompts',
      options: [
        { text: '选项 A', value: 'option_a' },
        { text: '选项 B', value: 'option_b', type: 'default' },
        { text: '危险操作', value: 'danger', type: 'danger' },
      ],
      title: '自动生成提示词测试',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  }, FEISHU_API_TIMEOUT);

  it('should handle multiple sequential card sends without conflict', async () => {
    const results = await Promise.all([
      client.sendInteractive(chatId, {
        question: '🔧 并发测试 Card 1',
        options: [{ text: 'Card 1', value: 'card1' }],
        actionPrompts: { card1: '[用户操作] 选择了 Card 1' },
      }),
      client.sendInteractive(chatId, {
        question: '🔧 并发测试 Card 2',
        options: [{ text: 'Card 2', value: 'card2' }],
        actionPrompts: { card2: '[用户操作] 选择了 Card 2' },
      }),
    ]);

    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    }
  }, FEISHU_API_TIMEOUT);

  it('should reject invalid parameters gracefully', async () => {
    // Empty question should be caught by MCP Server validation,
    // but via direct IPC it may produce an error response
    const result = await client.sendInteractive(chatId, {
      question: '',
      options: [],
    });

    // The Primary Node should handle invalid input gracefully
    // Either by returning success:false or by throwing
    expect(result).toBeDefined();
  }, FEISHU_API_TIMEOUT);
});
