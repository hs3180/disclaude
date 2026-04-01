/**
 * Feishu Integration Test: Text message send/receive end-to-end.
 *
 * Tests the IPC sendMessage flow — verifies that a text message can be
 * sent to a Feishu chat via the IPC layer and a valid messageId is returned.
 *
 * **Priority**: P1
 *
 * **Prerequisites** (when FEISHU_INTEGRATION_TEST=true):
 * - Primary Node must be running with Feishu channel connected
 * - IPC socket must be accessible
 * - FEISHU_TEST_CHAT_ID must point to a valid test group chat
 *
 * @see Issue #1626 - Optional Feishu integration test framework
 */

import { describe, it, expect } from 'vitest';
import {
  describeIfFeishu,
  itIfFeishu,
  getTestChatId,
  IPC_TIMEOUT,
  FEISHU_INTEGRATION,
} from './helpers.js';

describeIfFeishu('IPC sendMessage — end-to-end flow', () => {
  itIfFeishu('should send a text message and receive a messageId', async () => {
    const chatId = getTestChatId();

    const { getIpcClient, resetIpcClient } = await import(
      '@disclaude/core'
    );

    try {
      resetIpcClient();

      const client = getIpcClient();
      const result = await client.sendMessage(
        chatId,
        '🔔 Integration Test — 这是一条测试消息，请忽略'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    } finally {
      resetIpcClient();
    }
  }, IPC_TIMEOUT);

  itIfFeishu('should send a message with threadId for threaded replies', async () => {
    // TODO: Implement threaded message test once thread support is validated
    // This requires a known messageId to use as the thread parent
  }, IPC_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Always-run marker test
// ---------------------------------------------------------------------------
describe('Feishu integration test framework — sendMessage', () => {
  it('should have FEISHU_INTEGRATION flag available', () => {
    expect(typeof FEISHU_INTEGRATION).toBe('boolean');
  });
});
