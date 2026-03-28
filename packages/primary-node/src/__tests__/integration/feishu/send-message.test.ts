/**
 * Feishu Integration Test: IPC sendMessage End-to-End.
 *
 * Tests the complete sendMessage flow via IPC:
 * 1. Connect to Primary Node via IPC
 * 2. Send text messages to a Feishu chat
 * 3. Verify message delivery responses
 * 4. Test various message formats
 *
 * Prerequisites:
 * - Primary Node running with Feishu channel configured
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - DISCLAUDE_IPC_SOCKET_PATH set to the running server's socket path
 *
 * Priority: P1
 *
 * @module __tests__/integration/feishu/send-message
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

describeIfFeishu('IPC sendMessage End-to-End', () => {
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

  it('should send a simple text message', async () => {
    const testId = generateTestId();
    const result = await client.sendMessage(chatId, `Integration test: simple message (${testId})`);

    expect(result.success).toBe(true);
  });

  it('should send a message with special characters', async () => {
    const testId = generateTestId();
    const specialText = `Special chars: <>&"'\n\t行1\n行2\n行3 (${testId})`;
    const result = await client.sendMessage(chatId, specialText);

    expect(result.success).toBe(true);
  });

  it('should send a long message', async () => {
    const testId = generateTestId();
    const longText = `Long message test (${testId}):\n` + Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: 这是一段测试文本用于验证长消息发送功能。`).join('\n');
    const result = await client.sendMessage(chatId, longText);

    expect(result.success).toBe(true);
  });

  it('should send a message with emoji', async () => {
    const testId = generateTestId();
    const emojiText = `Emoji test (${testId}): 🎉 ✅ ❌ 🚀 📊 🔍 💡 ⚡ 🎯 🛠️`;
    const result = await client.sendMessage(chatId, emojiText);

    expect(result.success).toBe(true);
  });

  it('should send multiple messages sequentially', async () => {
    const testId = generateTestId();
    const count = 5;
    const results = [];

    for (let i = 0; i < count; i++) {
      const result = await client.sendMessage(chatId, `Sequential message ${i + 1}/${count} (${testId})`);
      results.push(result);
      // Small delay between messages to avoid rate limiting
      await delay(100);
    }

    for (const result of results) {
      expect(result.success).toBe(true);
    }
  });

  it('should send markdown-formatted message', async () => {
    const testId = generateTestId();
    const markdownText = [
      `**Markdown Test (${testId})**`,
      '',
      '- Item 1',
      '- Item 2',
      '- Item 3',
      '',
      '`code snippet`',
      '',
      '> Quote block',
    ].join('\n');

    const result = await client.sendMessage(chatId, markdownText);

    expect(result.success).toBe(true);
  });
});
