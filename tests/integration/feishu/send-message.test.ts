/**
 * Integration tests for IPC sendMessage end-to-end flow.
 *
 * Tests the complete chain: IPC request → text message delivery.
 *
 * Prerequisites:
 *   - Primary Node must be running with IPC enabled
 *   - FEISHU_INTEGRATION_TEST=true
 *   - FEISHU_TEST_CHAT_ID set to a valid chat where the bot is a member
 *
 * @see Issue #1626 - Feishu integration test framework
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getTestSocketPath,
} from './helpers.js';

describeIfFeishu('IPC sendMessage end-to-end', () => {
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

  it('should send a plain text message', async () => {
    const result = await client.sendMessage(
      chatId,
      '[集成测试] sendMessage 基础测试 - ' + new Date().toISOString()
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
  });

  it('should send a message with mentions', async () => {
    const result = await client.sendMessage(
      chatId,
      '[集成测试] 带 @mention 的消息测试',
      undefined,
      [{ openId: 'test_user_open_id', name: '测试用户' }]
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send a long text message', async () => {
    const longText = '[集成测试] 长文本消息 '.repeat(50);
    const result = await client.sendMessage(chatId, longText);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should handle Unicode and emoji content', async () => {
    const result = await client.sendMessage(
      chatId,
      '[集成测试] Unicode 测试: 🎉 中文 日本語 한글 العربية 😊'
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });
});
