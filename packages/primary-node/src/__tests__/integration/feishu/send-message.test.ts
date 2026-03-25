/**
 * Integration tests for IPC sendMessage end-to-end.
 *
 * Tests text message sending via IPC to verify the complete chain
 * from Worker Node through IPC to Feishu API.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chatId> npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient, getIpcSocketPath, resetIpcClient } from '@disclaude/core';
import { describeIfFeishu, setupFeishuIntegration, INTEGRATION_TIMEOUT, sleep } from './helpers.js';

describeIfFeishu('IPC sendMessage end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    chatId = setupFeishuIntegration();

    resetIpcClient();
    client = new UnixSocketIpcClient({
      socketPath: getIpcSocketPath(),
      timeout: 10000,
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await client.disconnect();
    resetIpcClient();
  });

  it(
    'should send a plain text message',
    async () => {
      const result = await client.sendMessage(
        chatId,
        '🧪 Integration test: plain text message'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send a markdown-formatted message',
    async () => {
      const result = await client.sendMessage(
        chatId,
        '**Bold** and *italic* text\n\n- List item 1\n- List item 2\n\n`code block`'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send a long message',
    async () => {
      const longText = 'Integration test: '.repeat(100);
      const result = await client.sendMessage(chatId, longText);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should handle Unicode and emoji content',
    async () => {
      const result = await client.sendMessage(
        chatId,
        '🧪 こんにちは世界 🌍 مرحبا بالعالم 🎉 测试消息'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send messages rapidly in sequence',
    async () => {
      const messageCount = 3;
      const results = [];

      for (let i = 0; i < messageCount; i++) {
        const result = await client.sendMessage(
          chatId,
          `🧪 Rapid message #${i + 1} of ${messageCount}`
        );
        results.push(result);
      }

      for (let i = 0; i < messageCount; i++) {
        expect(results[i].success).toBe(true);
        expect(results[i].messageId).toBeDefined();
      }

      // Verify distinct messageIds
      const messageIds = results.map((r) => r.messageId).filter(Boolean);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(messageCount);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send a message with threadId',
    async () => {
      // First send a parent message
      const parentResult = await client.sendMessage(
        chatId,
        '🧪 Integration test: parent message for thread reply'
      );
      expect(parentResult.success).toBe(true);

      const threadId = parentResult.messageId;
      if (!threadId) {
        console.warn('Skipping thread reply test: no messageId from parent');
        return;
      }

      await sleep(500);

      // Reply in thread
      const replyResult = await client.sendMessage(
        chatId,
        '🧪 Integration test: thread reply',
        threadId
      );
      expect(replyResult.success).toBe(true);
    },
    INTEGRATION_TIMEOUT
  );
});
