/**
 * IPC sendMessage integration test.
 *
 * Tests the IPC sendMessage flow with a real IPC server/client.
 *
 * Tier 1: No Feishu credentials required (uses mock handlers).
 *
 * @module __tests__/integration/feishu/send-message
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
} from '@disclaude/core';
import { describeIfFeishu, generateTestMarker } from './helpers.js';

describeIfFeishu('IPC sendMessage flow', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  const sentMessages: Array<{
    chatId: string;
    text: string;
    threadId?: string;
  }> = [];

  function generateSocketPath(): string {
    return join(
      tmpdir(),
      `feishu-msg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
    );
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    sentMessages.length = 0;

    const handler = createInteractiveMessageHandler(
      () => {},
      {
        handlers: {
          sendMessage: async (chatId, text, threadId) => {
            sentMessages.push({ chatId, text, threadId });
          },
          sendCard: async () => {},
          uploadFile: async () => ({
            fileKey: '',
            fileType: 'file',
            fileName: 'f',
            fileSize: 0,
          }),
          sendInteractive: async (_chatId, params) => ({
            messageId: `om_${params.options[0]?.value}`,
          }),
        },
      }
    );

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  });

  it('should send text message via IPC', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const text = `Integration test message at ${new Date().toISOString()}`;

    const result = await client.sendMessage(chatId, text);

    expect(result.success).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({ chatId, text, threadId: undefined });
  });

  it('should send text message with threadId via IPC', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const threadId = `thread_${generateTestMarker()}`;
    const text = 'Threaded message';

    const result = await client.sendMessage(chatId, text, threadId);

    expect(result.success).toBe(true);
    expect(sentMessages[0].threadId).toBe(threadId);
  });

  it('should handle multiple sequential messages', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    await client.sendMessage(chatId, 'Message 1');
    await client.sendMessage(chatId, 'Message 2');
    await client.sendMessage(chatId, 'Message 3');

    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.map((m) => m.text)).toEqual([
      'Message 1',
      'Message 2',
      'Message 3',
    ]);
  });

  it('should handle messages to different chats', async () => {
    const chat1 = `oc_test_${generateTestMarker()}`;
    const chat2 = `oc_test_${generateTestMarker()}`;

    await client.sendMessage(chat1, 'Hello chat 1');
    await client.sendMessage(chat2, 'Hello chat 2');

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].chatId).toBe(chat1);
    expect(sentMessages[1].chatId).toBe(chat2);
  });
});
