/**
 * P1: Text message send/receive end-to-end test.
 *
 * Tests the IPC sendMessage chain:
 * 1. Text message sending via IPC
 * 2. Success response verification
 *
 * Requires:
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - Running Primary Node with IPC server and Feishu handlers
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FEISHU_INTEGRATION,
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  createTestMessage,
} from './helpers.js';
import { UnixSocketIpcClient } from '../../packages/core/dist/ipc/unix-socket-client.js';

describeIfFeishu('IPC sendMessage end-to-end', () => {
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

  it('should send a plain text message', async () => {
    const msg = createTestMessage();
    const result = await client.sendMessage(chatId, msg.text);

    expect(result.success).toBe(true);
  });

  it('should send a message with threadId', async () => {
    const msg = createTestMessage({
      text: `🧪 [Thread Test] Message at ${Date.now()}`,
    });
    const threadId = 'test-thread-' + Date.now();

    const result = await client.sendMessage(chatId, msg.text, threadId);

    expect(result.success).toBe(true);
  });

  it('should send a long message', async () => {
    const longText = '🧪 [Long Message Test] ' + 'A'.repeat(4000);
    const result = await client.sendMessage(chatId, longText);

    expect(result.success).toBe(true);
  });

  it('should send messages with special characters', async () => {
    const specialText = '🧪 [Special Chars] 你好世界 🌍 <>&"\'` \\n \\t {}[]';
    const result = await client.sendMessage(chatId, specialText);

    expect(result.success).toBe(true);
  });
});

// When tests are disabled, output a skip notice
describe('Feishu Integration Tests - sendMessage', () => {
  it('should be enabled via FEISHU_INTEGRATION_TEST=true', () => {
    if (!FEISHU_INTEGRATION) {
      console.log(
        '\n⏭️  Feishu sendMessage integration tests are skipped by default.\n' +
        '   To enable: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chat_id> npm run test:feishu\n'
      );
    }
    expect(true).toBe(true);
  });
});
