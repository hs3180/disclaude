/**
 * P0: IPC sendInteractive end-to-end test.
 *
 * Tests the full sendInteractive chain:
 * 1. Card sending via IPC
 * 2. Success response with messageId
 * 3. Action prompts registration
 *
 * Requires:
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - Running Primary Node with IPC server and Feishu handlers
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1570 - sendInteractive IPC flow
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

describeIfFeishu('IPC sendInteractive end-to-end', () => {
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

  it('should send an interactive card and receive messageId', async () => {
    const params = createTestInteractiveParams();
    const result = await client.sendInteractive(chatId, params);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
  });

  it('should send a card with custom action prompts', async () => {
    const customPrompts = {
      approve: '[Test] User approved the action',
      reject: '[Test] User rejected the action',
    };

    const params = createTestInteractiveParams({
      question: '🧪 Custom prompts test',
      options: [
        { text: 'Approve', value: 'approve', type: 'primary' },
        { text: 'Reject', value: 'reject', type: 'danger' },
      ],
      actionPrompts: customPrompts,
    });

    const result = await client.sendInteractive(chatId, params);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send a card with threadId support', async () => {
    const params = createTestInteractiveParams({
      question: '🧪 Thread test',
      threadId: 'test-thread-' + Date.now(),
    });

    const result = await client.sendInteractive(chatId, params);

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should handle multiple cards sent in rapid succession', async () => {
    const params1 = createTestInteractiveParams({
      question: '🧪 Rapid fire card 1',
    });
    const params2 = createTestInteractiveParams({
      question: '🧪 Rapid fire card 2',
    });

    const [result1, result2] = await Promise.all([
      client.sendInteractive(chatId, params1),
      client.sendInteractive(chatId, params2),
    ]);

    expect(result1.success).toBe(true);
    expect(result1.messageId).toBeDefined();
    expect(result2.success).toBe(true);
    expect(result2.messageId).toBeDefined();
    // Each card should have a unique messageId
    expect(result1.messageId).not.toBe(result2.messageId);
  });
});

// When tests are disabled, output a skip notice
describe('Feishu Integration Tests - sendInteractive', () => {
  it('should be enabled via FEISHU_INTEGRATION_TEST=true', () => {
    if (!FEISHU_INTEGRATION) {
      console.log(
        '\n⏭️  Feishu integration tests are skipped by default.\n' +
        '   To enable: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chat_id> npm run test:feishu\n'
      );
    }
    expect(true).toBe(true);
  });
});
