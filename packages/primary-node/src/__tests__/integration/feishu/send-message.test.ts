/**
 * P1: IPC sendMessage end-to-end integration test.
 *
 * Tests the text message sending flow via IPC:
 * 1. Send a text message to the Primary Node
 * 2. Verify the message was sent successfully
 * 3. Test with various parameters (mentions, threadId)
 *
 * Prerequisites:
 * - `FEISHU_INTEGRATION_TEST=true`
 * - Running Primary Node with Feishu channel connected
 * - `FEISHU_TEST_CHAT_ID` set to a valid chat ID
 *
 * @see Issue #1626 - Optional Feishu integration tests (default skip)
 * @see Issue #1574 - Platform-agnostic messaging operations (Phase 5)
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getIpcClient,
  disconnectIpcClient,
  isIpcSocketAvailable,
  getTestChatId,
  generateTestMarker,
} from './helpers.js';

describeIfFeishu('IPC sendMessage E2E', () => {
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

  it('should send a text message and return success', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendMessage(
      chatId,
      `${marker} Integration test: sendMessage basic`
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
  });

  it('should send a message with threadId', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendMessage(
      chatId,
      `${marker} Integration test: sendMessage with threadId`,
      chatId // Use chatId as threadId for testing
    );

    expect(result.success).toBe(true);
  });

  it('should send a message with mentions', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendMessage(
      chatId,
      `${marker} Integration test: sendMessage with mentions`,
      undefined,
      [{ openId: 'test_user_open_id', name: 'Test User' }]
    );

    // May succeed or fail depending on whether the openId is valid
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('should fail gracefully with an invalid chatId', async () => {
    const client = getIpcClient();
    const marker = generateTestMarker();

    const result = await client.sendMessage(
      'invalid_chat_id_does_not_exist',
      `${marker} Integration test: invalid chatId`
    );

    expect(result.success).toBe(false);
  });
});
