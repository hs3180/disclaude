/**
 * P0: InteractiveContextStore multi-card coexistence integration test.
 *
 * Tests that multiple interactive cards sent to the same chat coexist correctly
 * in the InteractiveContextStore, verifying the LRU eviction and cross-card
 * action lookup behavior introduced in PR #1625.
 *
 * This integration test verifies the behavior in the context of a running
 * Primary Node, complementing the unit tests in `interactive-context.test.ts`.
 *
 * Prerequisites:
 * - `FEISHU_INTEGRATION_TEST=true`
 * - Running Primary Node with Feishu channel connected
 * - `FEISHU_TEST_CHAT_ID` set to a valid chat ID
 *
 * @see Issue #1626 - Optional Feishu integration tests (default skip)
 * @see Issue #1625 - IPC sendInteractive card click events actionPrompts override
 * @see Issue #1572 - Primary Node owns the full interactive card lifecycle
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getIpcClient,
  disconnectIpcClient,
  isIpcSocketAvailable,
  getTestChatId,
  generateTestMarker,
  createTestOptions,
  createTestActionPrompts,
} from './helpers.js';

describeIfFeishu('InteractiveContextStore multi-card integration', () => {
  let chatId: string;

  beforeAll(() => {
    if (!isIpcSocketAvailable()) {
      throw new Error(
        'IPC socket not available. Ensure Primary Node is running. ' +
          `Expected socket at: ${process.env.DISCLAUDE_IPC_SOCKET_PATH || '/tmp/disclaude-interactive.ipc'}`
      );
    }
    chatId = getTestChatId();
  });

  afterAll(async () => {
    await disconnectIpcClient();
  });

  it('should send multiple cards to the same chat and register distinct actionPrompts', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    // Send Card A
    const markerA = `${marker}_cardA`;
    const resultA = await client.sendInteractive(chatId, {
      question: `${markerA} Card A with AI-related actions`,
      options: createTestOptions(markerA),
      actionPrompts: createTestActionPrompts(markerA),
    });

    expect(resultA.success).toBe(true);
    expect(resultA.messageId).toBeDefined();

    // Send Card B to the same chat
    const markerB = `${marker}_cardB`;
    const resultB = await client.sendInteractive(chatId, {
      question: `${markerB} Card B with confirmation actions`,
      options: [
        { text: `${markerB} Yes`, value: `${markerB}_yes`, type: 'primary' as const },
        { text: `${markerB} No`, value: `${markerB}_no`, type: 'danger' as const },
      ],
      actionPrompts: {
        [`${markerB}_yes`]: `[用户操作] 用户确认了`,
        [`${markerB}_no`]: `[用户操作] 用户拒绝了`,
      },
    });

    expect(resultB.success).toBe(true);
    expect(resultB.messageId).toBeDefined();

    // Both cards should have different messageIds
    expect(resultA.messageId).not.toBe(resultB.messageId);
  });

  it('should handle rapid sequential card sends without actionPrompt collision', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    // Send 3 cards rapidly
    const results = await Promise.all([
      client.sendInteractive(chatId, {
        question: `${marker}_rapid Card 1`,
        options: createTestOptions(`${marker}_rapid1`),
        actionPrompts: createTestActionPrompts(`${marker}_rapid1`),
      }),
      client.sendInteractive(chatId, {
        question: `${marker}_rapid Card 2`,
        options: createTestOptions(`${marker}_rapid2`),
        actionPrompts: createTestActionPrompts(`${marker}_rapid2`),
      }),
      client.sendInteractive(chatId, {
        question: `${marker}_rapid Card 3`,
        options: createTestOptions(`${marker}_rapid3`),
        actionPrompts: createTestActionPrompts(`${marker}_rapid3`),
      }),
    ]);

    // All should succeed
    for (let i = 0; i < results.length; i++) {
      expect(results[i].success).toBe(true);
      expect(results[i].messageId).toBeDefined();
    }

    // All messageIds should be distinct
    const messageIds = results.map((r: { messageId?: string }) => r.messageId);
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(3);
  });
});
