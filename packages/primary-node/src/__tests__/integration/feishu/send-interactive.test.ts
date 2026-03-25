/**
 * Integration tests for IPC sendInteractive complete flow.
 *
 * Tests the end-to-end chain: card sending → actionPrompts registration → callback verification.
 * These tests require a running Primary Node with IPC socket and valid Feishu API credentials.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chatId> npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1570 - sendInteractive IPC flow
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient, getIpcSocketPath, resetIpcClient } from '@disclaude/core';
import { describeIfFeishu, setupFeishuIntegration, INTEGRATION_TIMEOUT } from './helpers.js';

describeIfFeishu('IPC sendInteractive end-to-end', () => {
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
    'should send an interactive card and receive a messageId',
    async () => {
      const result = await client.sendInteractive(chatId, {
        question: 'Integration test: Choose an option',
        options: [
          { text: 'Option A', value: 'option_a', type: 'primary' },
          { text: 'Option B', value: 'option_b' },
          { text: 'Cancel', value: 'cancel', type: 'danger' },
        ],
        title: '🧪 Integration Test',
        context: 'This is an automated integration test. Please ignore.',
        actionPrompts: {
          option_a: '[用户操作] 用户选择了 Option A',
          option_b: '[用户操作] 用户选择了 Option B',
          cancel: '[用户操作] 用户取消了操作',
        },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');
      expect(result.messageId!.length).toBeGreaterThan(0);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should register actionPrompts that can be looked up by messageId',
    async () => {
      const actionPrompts = {
        approve: '[用户操作] 用户点击了「批准」',
        reject: '[用户操作] 用户点击了「拒绝」',
      };

      const result = await client.sendInteractive(chatId, {
        question: 'Integration test: Action prompts registration',
        options: [
          { text: 'Approve', value: 'approve', type: 'primary' },
          { text: 'Reject', value: 'reject', type: 'danger' },
        ],
        title: '🧪 Action Prompts Test',
        actionPrompts,
      });

      expect(result.success).toBe(true);

      // The messageId returned should correspond to the registered context.
      // In the full system, clicking a button with value "approve" should
      // produce the prompt "[用户操作] 用户点击了「批准」".
      // This test verifies the send phase succeeds; the callback phase
      // is tested separately in interactive-context.test.ts.
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should handle cards with threadId for thread reply',
    async () => {
      // First send a message to get a threadId (messageId to reply to)
      const sendResult = await client.sendMessage(chatId, 'Integration test: parent message for thread');
      expect(sendResult.success).toBe(true);

      const threadId = sendResult.messageId;
      if (!threadId) {
        // If no messageId returned, skip thread test
        console.warn('Skipping threadId test: no messageId returned from sendMessage');
        return;
      }

      // Send interactive card as thread reply
      const result = await client.sendInteractive(chatId, {
        question: 'Integration test: Thread reply card',
        options: [{ text: 'OK', value: 'ok' }],
        title: '🧪 Thread Test',
        threadId,
        actionPrompts: { ok: '[用户操作] 用户点击了 OK' },
      });

      expect(result.success).toBe(true);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should handle cards with context information',
    async () => {
      const longContext = 'A'.repeat(500); // Test with a longer context string

      const result = await client.sendInteractive(chatId, {
        question: 'Integration test: Long context',
        options: [{ text: 'Dismiss', value: 'dismiss' }],
        context: longContext,
        actionPrompts: { dismiss: '[用户操作] 用户关闭了通知' },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should handle minimal card parameters',
    async () => {
      const result = await client.sendInteractive(chatId, {
        question: 'Minimal test',
        options: [{ text: 'OK', value: 'ok' }],
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TIMEOUT
  );
});
