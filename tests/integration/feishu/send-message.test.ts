/**
 * P1 Integration test: IPC sendMessage end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendMessage()  →  IPC Server  →  Mock sendMessage handler
 *
 * Verifies text message sending through the IPC layer with various
 * parameter combinations (threadId, mentions, error handling).
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1574 — Platform-agnostic messaging operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  let capturedArgs: {
    chatId?: string;
    text?: string;
    threadId?: string;
    mentions?: Array<{ openId: string; name?: string }>;
  };

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedArgs = {};

    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async (chatId, text, threadId?, mentions?) => {
          capturedArgs = { chatId, text, threadId, mentions };
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };

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

  it('should send a basic text message and deliver correct args', async () => {
    const result = await client.sendMessage('oc_test_chat', 'Hello, World!');

    expect(result.success).toBe(true);
    expect(capturedArgs.chatId).toBe('oc_test_chat');
    expect(capturedArgs.text).toBe('Hello, World!');
    expect(capturedArgs.threadId).toBeUndefined();
    expect(capturedArgs.mentions).toBeUndefined();
  });

  it('should send a message with threadId for threaded replies', async () => {
    const result = await client.sendMessage('oc_thread_chat', 'Reply in thread', 'om_parent_msg');

    expect(result.success).toBe(true);
    expect(capturedArgs.chatId).toBe('oc_thread_chat');
    expect(capturedArgs.text).toBe('Reply in thread');
    expect(capturedArgs.threadId).toBe('om_parent_msg');
  });

  it('should send a message with mentions', async () => {
    const mentions = [
      { openId: 'ou_user_001', name: 'Alice' },
      { openId: 'ou_user_002', name: 'Bob' },
    ];

    const result = await client.sendMessage('oc_mention_chat', 'Hey everyone!', undefined, mentions);

    expect(result.success).toBe(true);
    expect(capturedArgs.chatId).toBe('oc_mention_chat');
    expect(capturedArgs.text).toBe('Hey everyone!');
    expect(capturedArgs.mentions).toEqual(mentions);
  });

  it('should send a message with both threadId and mentions', async () => {
    const mentions = [{ openId: 'ou_user_003', name: 'Charlie' }];

    const result = await client.sendMessage(
      'oc_combined_chat',
      'Threaded mention',
      'om_thread_parent',
      mentions,
    );

    expect(result.success).toBe(true);
    expect(capturedArgs.threadId).toBe('om_thread_parent');
    expect(capturedArgs.mentions).toEqual(mentions);
  });

  it('should handle multilingual text messages', async () => {
    const messages = [
      '你好世界！', // Chinese
      'こんにちは世界', // Japanese
      '안녕하세요 세계', // Korean
      '🎉🚀 Hello World 🌍', // Mixed with emojis
      'Line1\nLine2\nLine3', // Multi-line
    ];

    for (const text of messages) {
      const result = await client.sendMessage('oc_i18n_chat', text);
      expect(result.success).toBe(true);
      expect(capturedArgs.text).toBe(text);
    }
  });

  it('should return error when channel handlers are not available', async () => {
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

  it('should return error when sendMessage handler throws', async () => {
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

  it('should send multiple messages to different chats concurrently', async () => {
    const results = await Promise.all([
      client.sendMessage('oc_chat_a', 'Message A'),
      client.sendMessage('oc_chat_b', 'Message B'),
      client.sendMessage('oc_chat_c', 'Message C'),
    ]);

    for (const result of results) {
      expect(result.success).toBe(true);
    }
  });
});
