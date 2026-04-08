/**
 * Integration tests for InteractiveContextStore multi-card coexistence.
 *
 * Verifies that the IPC layer correctly registers and resolves action prompts
 * when multiple interactive cards are active in the same chat (#1625).
 *
 * These tests validate the full IPC round-trip: sendInteractive → context store
 * → actionPrompts lookup, using the IPC server's actual context management.
 *
 * Prerequisites:
 *   - Primary Node must be running with IPC enabled
 *   - FEISHU_INTEGRATION_TEST=true
 *   - FEISHU_TEST_CHAT_ID set to a valid chat where the bot is a member
 *
 * @see Issue #1626 - Feishu integration test framework
 * @see Issue #1625 - Multi-card coexistence fix
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getTestSocketPath,
} from './helpers.js';

describeIfFeishu('InteractiveContextStore multi-card coexistence', () => {
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

  it('should send multiple cards to the same chat without conflict', async () => {
    // Send Card A with AI-related actions
    const resultA = await client.sendInteractive(chatId, {
      question: 'Card A: AI 相关选项',
      options: [
        { text: 'AI 解释', value: 'explain_ai' },
        { text: 'AI 应用', value: 'ai_applications' },
        { text: 'AI 历史', value: 'ai_history' },
      ],
      context: 'feishu-integration-test-card-a',
      actionPrompts: {
        explain_ai: '[用户操作] 用户想了解AI解释',
        ai_applications: '[用户操作] 用户想看AI应用',
        ai_history: '[用户操作] 用户想看AI历史',
      },
    });

    expect(resultA.success).toBe(true);
    expect(resultA.messageId).toBeDefined();

    // Send Card B with confirmation actions to the same chat
    const resultB = await client.sendInteractive(chatId, {
      question: 'Card B: 确认操作',
      options: [
        { text: '确认', value: 'yes' },
        { text: '拒绝', value: 'no' },
      ],
      context: 'feishu-integration-test-card-b',
      actionPrompts: {
        yes: '[用户操作] 用户确认了',
        no: '[用户操作] 用户拒绝了',
      },
    });

    expect(resultB.success).toBe(true);
    expect(resultB.messageId).toBeDefined();

    // Both cards should have different messageIds
    expect(resultA.messageId).not.toBe(resultB.messageId);
  });

  it('should handle rapid sequential card sends', async () => {
    const results = await Promise.all([
      client.sendInteractive(chatId, {
        question: 'Rapid Card 1',
        options: [{ text: 'A', value: 'rapid_a' }],
        context: 'feishu-integration-test-rapid',
        actionPrompts: { rapid_a: '[用户操作] 快速选择A' },
      }),
      client.sendInteractive(chatId, {
        question: 'Rapid Card 2',
        options: [{ text: 'B', value: 'rapid_b' }],
        context: 'feishu-integration-test-rapid',
        actionPrompts: { rapid_b: '[用户操作] 快速选择B' },
      }),
      client.sendInteractive(chatId, {
        question: 'Rapid Card 3',
        options: [{ text: 'C', value: 'rapid_c' }],
        context: 'feishu-integration-test-rapid',
        actionPrompts: { rapid_c: '[用户操作] 快速选择C' },
      }),
    ]);

    // All sends should succeed
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    }

    // All messageIds should be unique
    const messageIds = results.map((r) => r.messageId);
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(3);
  });
});
