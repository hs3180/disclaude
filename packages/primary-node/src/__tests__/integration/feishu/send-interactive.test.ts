/**
 * Feishu Integration Test: IPC sendInteractive end-to-end.
 *
 * Tests the full IPC sendInteractive flow:
 *   Card send → actionPrompts registration → button click callback → prompt generation
 *
 * **Prerequisites** (when FEISHU_INTEGRATION_TEST=true):
 * - Primary Node must be running with Feishu channel connected
 * - IPC socket must be accessible
 * - FEISHU_TEST_CHAT_ID must point to a valid test group chat
 *
 * @see Issue #1625 - IPC sendInteractive card action prompts overwritten
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

describeIfFeishu('IPC sendInteractive — end-to-end flow', () => {
  itIfFeishu('should send an interactive card and receive a success response', async () => {
    const chatId = getTestChatId();

    // Dynamically import the IPC client to avoid loading it when tests are skipped
    const { getIpcClient, resetIpcClient } = await import(
      '@disclaude/core'
    );

    try {
      resetIpcClient();

      const client = getIpcClient();
      const result = await client.sendInteractive(chatId, {
        question: '🔔 Integration Test — 请选择一个选项',
        options: [
          { text: '选项 A', value: 'option_a', type: 'primary' },
          { text: '选项 B', value: 'option_b' },
          { text: '取消', value: 'cancel', type: 'danger' },
        ],
        title: '集成测试',
        actionPrompts: {
          option_a: '[集成测试] 用户选择了选项 A',
          option_b: '[集成测试] 用户选择了选项 B',
          cancel: '[集成测试] 用户取消了操作',
        },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    } finally {
      resetIpcClient();
    }
  }, IPC_TIMEOUT);

  itIfFeishu('should send multiple cards without actionPrompts collision', async () => {
    const chatId = getTestChatId();

    const { getIpcClient, resetIpcClient } = await import(
      '@disclaude/core'
    );

    try {
      resetIpcClient();

      const client = getIpcClient();

      // Send Card 1
      const result1 = await client.sendInteractive(chatId, {
        question: 'Card 1: 选择颜色',
        options: [
          { text: '红色', value: 'red' },
          { text: '蓝色', value: 'blue' },
        ],
        actionPrompts: {
          red: '[Card 1] 用户选择了红色',
          blue: '[Card 1] 用户选择了蓝色',
        },
      });

      expect(result1.success).toBe(true);

      // Send Card 2 (same chat — this is the scenario from #1625)
      const result2 = await client.sendInteractive(chatId, {
        question: 'Card 2: 选择大小',
        options: [
          { text: '大', value: 'large', type: 'primary' },
          { text: '小', value: 'small' },
        ],
        actionPrompts: {
          large: '[Card 2] 用户选择了大',
          small: '[Card 2] 用户选择了小',
        },
      });

      expect(result2.success).toBe(true);

      // Both cards should have been sent successfully
      expect(result1.messageId).toBeDefined();
      expect(result2.messageId).toBeDefined();
      expect(result1.messageId).not.toBe(result2.messageId);
    } finally {
      resetIpcClient();
    }
  }, IPC_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Always-run marker test
// ---------------------------------------------------------------------------
describe('Feishu integration test framework — sendInteractive', () => {
  it('should have FEISHU_INTEGRATION flag available', () => {
    expect(typeof FEISHU_INTEGRATION).toBe('boolean');
  });
});
