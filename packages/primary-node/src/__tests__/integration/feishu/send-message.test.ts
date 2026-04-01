/**
 * Feishu Integration Test: IPC sendMessage End-to-End.
 *
 * Tests the full sendMessage flow:
 * 1. Text message sending via IPC → Primary Node → Feishu API
 * 2. Message delivery verification
 *
 * Priority: P1 (Important)
 *
 * Prerequisites:
 * - `FEISHU_INTEGRATION_TEST=true`
 * - `FEISHU_TEST_CHAT_ID=<valid_chat_id>`
 * - Running Primary Node with Feishu connection
 * - `DISCLADE_IPC_SOCKET=<socket_path>` (optional, uses default)
 *
 * @module integration/feishu/send-message
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1574 - Phase 5 of IPC refactor (sendMessage)
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  enableFeishuNetwork,
  INTEGRATION_TEST_TIMEOUT,
} from './helpers.js';
import { UnixSocketIpcClient } from '@disclaude/core';

describeIfFeishu('IPC sendMessage - End-to-End (P1)', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  let socketPath: string;
  let connected = false;

  beforeAll(async () => {
    enableFeishuNetwork();

    chatId = getTestChatId();
    socketPath = getIpcSocketPath();

    client = new UnixSocketIpcClient({
      socketPath,
      timeout: 10000,
      maxRetries: 2,
    });

    try {
      await client.connect();
      connected = true;
    } catch (error) {
      console.warn(
        `[Feishu Integration] Cannot connect to IPC server at ${socketPath}. ` +
          `Make sure Primary Node is running. Error: ${error}`
      );
    }
  }, INTEGRATION_TEST_TIMEOUT);

  afterAll(async () => {
    if (connected) {
      await client.disconnect();
    }
  });

  it('should be connected to the Primary Node IPC server', () => {
    expect(connected).toBe(true);
  });

  it(
    'should send a plain text message',
    async () => {
      if (!connected) return;

      const result = await client.sendMessage(chatId, '🧪 Integration Test: Plain text message');

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should send a long text message',
    async () => {
      if (!connected) return;

      const longText = '🧪 Long message test. '.repeat(50); // ~1000 chars
      const result = await client.sendMessage(chatId, longText);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should send a message with special characters',
    async () => {
      if (!connected) return;

      const specialText =
        '🧪 Special chars: <>&"\'`/\\中文日本語한국어🎉\n\tLine break\tTab';
      const result = await client.sendMessage(chatId, specialText);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should send multiple messages in sequence',
    async () => {
      if (!connected) return;

      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await client.sendMessage(
          chatId,
          `🧪 Sequential message ${i + 1}/3`
        );
        results.push(result);
      }

      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
      }

      // Each message should have a unique ID
      const messageIds = results.map((r) => r.messageId);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(3);
    },
    INTEGRATION_TEST_TIMEOUT
  );
});
