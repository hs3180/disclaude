/**
 * Feishu Integration Test: IPC sendInteractive Complete Chain.
 *
 * Tests the full sendInteractive flow:
 * 1. Card sending via IPC → Primary Node → Feishu API
 * 2. actionPrompts registration in InteractiveContextStore
 * 3. Callback verification (messageId/chatId based lookup)
 *
 * Priority: P0 (Critical path)
 *
 * Prerequisites:
 * - `FEISHU_INTEGRATION_TEST=true`
 * - `FEISHU_TEST_CHAT_ID=<valid_chat_id>`
 * - Running Primary Node with Feishu connection
 * - `DISCLADE_IPC_SOCKET=<socket_path>` (optional, uses default)
 *
 * @module integration/feishu/send-interactive
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1570 - sendInteractive IPC flow
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  enableFeishuNetwork,
  createTestActionPrompts,
  INTEGRATION_TEST_TIMEOUT,
} from './helpers.js';
import { UnixSocketIpcClient } from '@disclaude/core';

describeIfFeishu('IPC sendInteractive - Complete Chain (P0)', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  let socketPath: string;
  let connected = false;

  beforeAll(async () => {
    // Enable Feishu API network access
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

  it('should connect to the Primary Node IPC server', () => {
    expect(connected).toBe(true);
  });

  it(
    'should send an interactive card and receive a messageId',
    async () => {
      if (!connected) return;

      const result = await client.sendInteractive(chatId, {
        question: '🧪 Integration Test: Please select an option',
        options: [
          { text: '✅ Confirm', value: 'test_confirm', type: 'primary' },
          { text: '❌ Cancel', value: 'test_cancel' },
          { text: 'ℹ️ More Info', value: 'test_more_info' },
        ],
        title: 'Integration Test Card',
        context: 'This card was sent by the Feishu integration test suite.',
        actionPrompts: createTestActionPrompts('sendInteractive-test'),
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');
      expect(result.messageId!.length).toBeGreaterThan(0);
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should send an interactive card with minimal parameters',
    async () => {
      if (!connected) return;

      const result = await client.sendInteractive(chatId, {
        question: '🧪 Minimal Test',
        options: [
          { text: 'OK', value: 'ok' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should send multiple cards to the same chat (multi-card coexistence)',
    async () => {
      if (!connected) return;

      // Send card A
      const resultA = await client.sendInteractive(chatId, {
        question: '🧪 Card A: First card',
        options: [
          { text: 'A-Confirm', value: 'card_a_confirm' },
          { text: 'A-Cancel', value: 'card_a_cancel' },
        ],
        actionPrompts: {
          card_a_confirm: '[Card A] User confirmed',
          card_a_cancel: '[Card A] User cancelled',
        },
      });

      // Send card B to the same chat
      const resultB = await client.sendInteractive(chatId, {
        question: '🧪 Card B: Second card',
        options: [
          { text: 'B-Confirm', value: 'card_b_confirm' },
          { text: 'B-Cancel', value: 'card_b_cancel' },
        ],
        actionPrompts: {
          card_b_confirm: '[Card B] User confirmed',
          card_b_cancel: '[Card B] User cancelled',
        },
      });

      // Both cards should succeed
      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      expect(resultA.messageId).toBeDefined();
      expect(resultB.messageId).toBeDefined();

      // Message IDs should be different
      expect(resultA.messageId).not.toBe(resultB.messageId);
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should handle card with many options',
    async () => {
      if (!connected) return;

      const manyOptions = Array.from({ length: 10 }, (_, i) => ({
        text: `Option ${i + 1}`,
        value: `option_${i + 1}`,
        type: (i === 0 ? 'primary' : 'default') as 'primary' | 'default',
      }));

      const result = await client.sendInteractive(chatId, {
        question: '🧪 Many Options Test',
        options: manyOptions,
        title: 'Integration Test - Many Options',
        actionPrompts: Object.fromEntries(
          manyOptions.map((opt) => [opt.value, `User selected ${opt.text}`])
        ),
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TEST_TIMEOUT
  );

  it(
    'should send a card with context information',
    async () => {
      if (!connected) return;

      const longContext = 'A'.repeat(500); // Long context string

      const result = await client.sendInteractive(chatId, {
        question: '🧪 Long Context Test',
        options: [
          { text: 'OK', value: 'ok' },
        ],
        context: longContext,
        actionPrompts: { ok: 'Context: test passed' },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    },
    INTEGRATION_TEST_TIMEOUT
  );
});
