/**
 * P1: IPC sendMessage end-to-end integration test.
 *
 * Tests the complete flow of sending a text message via IPC:
 *   Text message → Primary Node → Feishu API → response
 *
 * Requires:
 *   FEISHU_INTEGRATION_TEST=true
 *   FEISHU_TEST_CHAT_ID=<valid_chat_id>
 *   A running Primary Node with Feishu connection
 *
 * Related: #1626, #1574
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

describeIfFeishu('IPC sendMessage end-to-end', () => {
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

  it('should send a plain text message successfully', async () => {
    const result = await client.sendMessage(
      chatId,
      '🔧 集成测试: 文本消息发送测试'
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
  }, FEISHU_API_TIMEOUT);

  it('should send a long text message', async () => {
    const longText = '🔧 集成测试: 长文本消息\n'.repeat(20);
    const result = await client.sendMessage(chatId, longText);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  }, FEISHU_API_TIMEOUT);

  it('should send a message with special characters', async () => {
    const specialText = '🔧 测试特殊字符: <>&"\'` emojis: 🎉🚀✅❌';
    const result = await client.sendMessage(chatId, specialText);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  }, FEISHU_API_TIMEOUT);

  it('should send multiple messages sequentially without conflict', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      const result = await client.sendMessage(
        chatId,
        `🔧 顺序消息 #${i + 1}`
      );
      results.push(result);
    }

    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    }
  }, FEISHU_API_TIMEOUT);
});
