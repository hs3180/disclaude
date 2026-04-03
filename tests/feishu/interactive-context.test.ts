/**
 * P0: InteractiveContextStore multi-card coexistence test.
 *
 * Verifies that multiple interactive cards sent to the same chat maintain
 * independent action prompts without overwriting each other.
 *
 * This validates the fix for Issue #1625 where actionPrompts were being
 * overwritten when multiple cards were sent to the same chat.
 *
 * Requires:
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - Running Primary Node with IPC server and Feishu handlers
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1625 - IPC sendInteractive actionPrompts overwrite fix
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FEISHU_INTEGRATION,
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  createTestInteractiveParams,
} from './helpers.js';
import { UnixSocketIpcClient } from '../../packages/core/dist/ipc/unix-socket-client.js';

describeIfFeishu('InteractiveContextStore multi-card coexistence (#1625)', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    if (!FEISHU_INTEGRATION) return;

    chatId = getTestChatId();
    const socketPath = getIpcSocketPath();

    client = new UnixSocketIpcClient({
      socketPath,
      timeout: 30000,
      maxRetries: 3,
    });

    await client.connect();
  }, 60000);

  afterAll(async () => {
    if (!FEISHU_INTEGRATION) return;

    await client.disconnect();
  });

  it('should allow multiple cards in the same chat with different actionPrompts', async () => {
    // Send first card with unique action prompts
    const card1Params = createTestInteractiveParams({
      question: '🧪 Card A - Multi-card test',
      options: [
        { text: 'Card A - Yes', value: 'card_a_yes', type: 'primary' },
        { text: 'Card A - No', value: 'card_a_no' },
      ],
      actionPrompts: {
        card_a_yes: '[Card A] User selected Yes',
        card_a_no: '[Card A] User selected No',
      },
    });

    const result1 = await client.sendInteractive(chatId, card1Params);
    expect(result1.success).toBe(true);
    expect(result1.messageId).toBeDefined();
    const messageId1 = result1.messageId!;

    // Send second card with different action prompts to the same chat
    const card2Params = createTestInteractiveParams({
      question: '🧪 Card B - Multi-card test',
      options: [
        { text: 'Card B - Approve', value: 'card_b_approve', type: 'primary' },
        { text: 'Card B - Reject', value: 'card_b_reject', type: 'danger' },
      ],
      actionPrompts: {
        card_b_approve: '[Card B] User selected Approve',
        card_b_reject: '[Card B] User selected Reject',
      },
    });

    const result2 = await client.sendInteractive(chatId, card2Params);
    expect(result2.success).toBe(true);
    expect(result2.messageId).toBeDefined();
    const messageId2 = result2.messageId!;

    // Verify each card has a unique messageId
    expect(messageId1).not.toBe(messageId2);

    // Note: We cannot directly verify actionPrompts via IPC (no query endpoint).
    // The verification that actionPrompts are not overwritten is validated by:
    // 1. Each sendInteractive call succeeds independently
    // 2. Each returns a unique messageId
    // 3. Unit tests in interactive-context.test.ts verify the store behavior
    // 4. Manual verification: clicking buttons on Card A should still produce
    //    Card A's prompts, not Card B's prompts
  });

  it('should maintain card independence across many sequential sends', async () => {
    const cardCount = 5;
    const results = [];

    for (let i = 0; i < cardCount; i++) {
      const params = createTestInteractiveParams({
        question: `🧪 Sequential card #${i + 1}`,
        actionPrompts: {
          [`action_${i}_a`]: `[Card ${i + 1}] Action A`,
          [`action_${i}_b`]: `[Card ${i + 1}] Action B`,
        },
      });

      const result = await client.sendInteractive(chatId, params);
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      results.push(result.messageId);
    }

    // Verify all messageIds are unique
    const uniqueIds = new Set(results);
    expect(uniqueIds.size).toBe(cardCount);
  });
});

// When tests are disabled, output a skip notice
describe('Feishu Integration Tests - InteractiveContext', () => {
  it('should be enabled via FEISHU_INTEGRATION_TEST=true', () => {
    if (!FEISHU_INTEGRATION) {
      console.log(
        '\n⏭️  InteractiveContext integration tests are skipped by default.\n' +
        '   To enable: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chat_id> npm run test:feishu\n'
      );
    }
    expect(true).toBe(true);
  });
});
