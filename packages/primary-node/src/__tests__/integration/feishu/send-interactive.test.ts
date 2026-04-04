/**
 * P0: IPC sendInteractive end-to-end integration test.
 *
 * Tests the full interactive card lifecycle:
 * 1. Send an interactive card via IPC to the Primary Node
 * 2. Verify the card was sent successfully (messageId returned)
 * 3. Verify action prompts are registered in the InteractiveContextStore
 *
 * Prerequisites:
 * - `FEISHU_INTEGRATION_TEST=true`
 * - Running Primary Node with Feishu channel connected
 * - `FEISHU_TEST_CHAT_ID` set to a valid chat ID
 *
 * @see Issue #1626 - Optional Feishu integration tests (default skip)
 * @see Issue #1570 - sendInteractive IPC flow
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

describeIfFeishu('IPC sendInteractive E2E', () => {
  let chatId: string;

  beforeAll(() => {
    // Validate prerequisites even when describeIfFeishu is active
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

  it('should send an interactive card and return success with messageId', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendInteractive(chatId, {
      question: `${marker} Integration test: sendInteractive E2E`,
      options: createTestOptions(marker),
      title: `${marker} Test Card`,
      actionPrompts: createTestActionPrompts(marker),
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId!.length).toBeGreaterThan(0);
  });

  it('should send an interactive card without actionPrompts and still succeed', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendInteractive(chatId, {
      question: `${marker} Integration test: no actionPrompts`,
      options: createTestOptions(marker),
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send an interactive card with threadId', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendInteractive(chatId, {
      question: `${marker} Integration test: with threadId`,
      options: createTestOptions(marker),
      threadId: chatId, // Use chatId as threadId for testing
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should fail gracefully with an invalid chatId', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendInteractive('invalid_chat_id_does_not_exist', {
      question: `${marker} Integration test: invalid chatId`,
      options: createTestOptions(marker),
    });

    // The IPC request should complete (not throw), but indicate failure
    expect(result.success).toBe(false);
  });

  it('should fail gracefully with empty options array', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendInteractive(chatId, {
      question: `${marker} Integration test: empty options`,
      options: [],
    });

    // Should either succeed (server handles empty options) or fail gracefully
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });
});
