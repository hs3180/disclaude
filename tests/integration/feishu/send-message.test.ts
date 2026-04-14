/**
 * P1 Integration test: IPC sendMessage end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendMessage()  →  IPC Server  →  Mock sendMessage handler
 *
 * Verifies text message sending works correctly through the IPC layer,
 * including threadId routing and mention support.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626 — Optional Feishu integration tests (default skipped)
 * @see Issue #1574 — Phase 5 of IPC refactor: platform-agnostic messaging
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('IPC sendMessage end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;

  /** Captured sendMessage calls for assertion */
  let capturedCalls: Array<{
    chatId: string;
    text: string;
    threadId?: string;
    mentions?: Array<{ openId: string; name?: string }>;
  }>;

  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async (chatId, text, threadId?, mentions?) => {
          capturedCalls.push({ chatId, text, threadId, mentions });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedCalls = [];

    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    try {
      await client.disconnect();
      await server.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should send a plain text message through IPC', async () => {
    const result = await client.sendMessage('oc_test_chat', 'Hello, World!');

    expect(result.success).toBe(true);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].chatId).toBe('oc_test_chat');
    expect(capturedCalls[0].text).toBe('Hello, World!');
    expect(capturedCalls[0].threadId).toBeUndefined();
    expect(capturedCalls[0].mentions).toBeUndefined();
  });

  it('should send a message with threadId for threaded replies', async () => {
    const result = await client.sendMessage('oc_test_chat', 'Thread reply', 'om_parent_msg');

    expect(result.success).toBe(true);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].threadId).toBe('om_parent_msg');
  });

  it('should send a message with mentions', async () => {
    const mentions = [
      { openId: 'ou_user_001', name: 'Alice' },
      { openId: 'ou_user_002', name: 'Bob' },
    ];

    const result = await client.sendMessage('oc_test_chat', '@Alice @Bob check this', undefined, mentions);

    expect(result.success).toBe(true);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].mentions).toEqual(mentions);
  });

  it('should send a message with both threadId and mentions', async () => {
    const mentions = [{ openId: 'ou_user_001', name: 'Alice' }];

    const result = await client.sendMessage(
      'oc_test_chat',
      '@Alice see this thread',
      'om_thread_123',
      mentions,
    );

    expect(result.success).toBe(true);
    expect(capturedCalls[0].threadId).toBe('om_thread_123');
    expect(capturedCalls[0].mentions).toEqual(mentions);
  });

  it('should handle multi-byte / CJK text correctly', async () => {
    const cjkText = '你好世界 🌍 émoji ñ';
    const result = await client.sendMessage('oc_test_chat', cjkText);

    expect(result.success).toBe(true);
    expect(capturedCalls[0].text).toBe(cjkText);
  });

  it('should handle very long messages', async () => {
    const longText = 'A'.repeat(10000);
    const result = await client.sendMessage('oc_test_chat', longText);

    expect(result.success).toBe(true);
    expect(capturedCalls[0].text).toBe(longText);
    expect(capturedCalls[0].text.length).toBe(10000);
  });

  it('should send multiple messages sequentially', async () => {
    const messages = ['First message', 'Second message', 'Third message'];

    for (const text of messages) {
      const result = await client.sendMessage('oc_test_chat', text);
      expect(result.success).toBe(true);
    }

    expect(capturedCalls).toHaveLength(3);
    expect(capturedCalls.map((c) => c.text)).toEqual(messages);
  });

  it('should return error when sendMessage handler is not available', async () => {
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

      const result = await emptyClient.sendMessage('oc_test', 'Hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(emptySocketPath);
    }
  });

  it('should return error when handler throws', async () => {
    const errorSocketPath = generateSocketPath();
    const errorContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {
          throw new Error('Feishu API rate limit exceeded');
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const errorHandler = createInteractiveMessageHandler(() => {}, errorContainer);
    const errorServer = new UnixSocketIpcServer(errorHandler, { socketPath: errorSocketPath });
    const errorClient = new UnixSocketIpcClient({ socketPath: errorSocketPath, timeout: 2000 });

    try {
      await errorServer.start();
      await errorClient.connect();

      const result = await errorClient.sendMessage('oc_test', 'Hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });
});
