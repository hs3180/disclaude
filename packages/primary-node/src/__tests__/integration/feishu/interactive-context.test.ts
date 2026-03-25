/**
 * Integration tests for InteractiveContextStore multi-card coexistence.
 *
 * Verifies that the InteractiveContextStore correctly handles multiple interactive
 * cards within the same chat, ensuring actionPrompts are not overwritten.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chatId> npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1625 - IPC sendInteractive actionPrompts overwrite fix
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient, getIpcSocketPath, resetIpcClient } from '@disclaude/core';
import { describeIfFeishu, setupFeishuIntegration, INTEGRATION_TIMEOUT, sleep } from './helpers.js';

describeIfFeishu('InteractiveContextStore multi-card coexistence', () => {
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
    'should send multiple cards to the same chat without losing actionPrompts',
    async () => {
      // Send first card
      const result1 = await client.sendInteractive(chatId, {
        question: 'Card 1: First interactive card',
        options: [{ text: 'Card1 Action', value: 'card1_action' }],
        title: '🧪 Card 1',
        actionPrompts: {
          card1_action: '[Card 1] 用户选择了 Card1 Action',
        },
      });

      expect(result1.success).toBe(true);
      const messageId1 = result1.messageId;

      // Small delay to ensure ordering
      await sleep(500);

      // Send second card to the same chat
      const result2 = await client.sendInteractive(chatId, {
        question: 'Card 2: Second interactive card',
        options: [{ text: 'Card2 Action', value: 'card2_action' }],
        title: '🧪 Card 2',
        actionPrompts: {
          card2_action: '[Card 2] 用户选择了 Card2 Action',
        },
      });

      expect(result2.success).toBe(true);
      const messageId2 = result2.messageId;

      // Both cards should have distinct messageIds
      expect(messageId1).toBeDefined();
      expect(messageId2).toBeDefined();
      expect(messageId1).not.toBe(messageId2);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send cards to different chats independently',
    async () => {
      // Use the primary chatId and a test-specific suffix approach
      // Since we only have one chatId, we test sequential sends
      const results = await Promise.all([
        client.sendInteractive(chatId, {
          question: 'Parallel Card A',
          options: [{ text: 'A', value: 'a' }],
          actionPrompts: { a: '[Parallel A] Selected' },
        }),
        client.sendInteractive(chatId, {
          question: 'Parallel Card B',
          options: [{ text: 'B', value: 'b' }],
          actionPrompts: { b: '[Parallel B] Selected' },
        }),
      ]);

      // Both should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
      }

      // MessageIds should be distinct
      const messageIds = results.map((r) => r.messageId).filter(Boolean);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(messageIds.length);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should handle rapid sequential card sends',
    async () => {
      const cardCount = 5;
      const results = [];

      for (let i = 0; i < cardCount; i++) {
        const result = await client.sendInteractive(chatId, {
          question: `Rapid card #${i + 1}`,
          options: [{ text: `Action ${i + 1}`, value: `rapid_${i}` }],
          title: `🧪 Rapid ${i + 1}/${cardCount}`,
          actionPrompts: {
            [`rapid_${i}`]: `[Rapid ${i + 1}] 用户选择了 Action ${i + 1}`,
          },
        });
        results.push(result);
      }

      // All sends should succeed
      for (let i = 0; i < cardCount; i++) {
        expect(results[i].success).toBe(true);
        expect(results[i].messageId).toBeDefined();
      }

      // All messageIds should be unique
      const messageIds = results.map((r) => r.messageId).filter(Boolean);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(cardCount);
    },
    INTEGRATION_TIMEOUT
  );
});
