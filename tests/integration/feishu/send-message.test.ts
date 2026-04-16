/**
 * P1 Integration test: IPC sendMessage end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendMessage()  →  IPC Server  →  Mock sendMessage handler  →  Response
 *
 * Verifies text message sending, thread support, mentions, and error handling
 * through the real Unix socket IPC transport layer.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1574 — Phase 5 of IPC refactor (platform-agnostic messaging)
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
  let capturedMessages: Array<{
    chatId: string;
    text: string;
    threadId?: string;
    mentions?: Array<{ openId: string; name?: string }>;
  }>;

  /** Create a mock container that captures sendMessage calls */
  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async (chatId, text, threadId?, mentions?) => {
          capturedMessages.push({ chatId, text, threadId, mentions });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedMessages = [];

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

  it('should send a plain text message and return success', async () => {
    const result = await client.sendMessage('oc_test_chat', 'Hello, World!');

    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].chatId).toBe('oc_test_chat');
    expect(capturedMessages[0].text).toBe('Hello, World!');
    expect(capturedMessages[0].threadId).toBeUndefined();
    expect(capturedMessages[0].mentions).toBeUndefined();
  });

  it('should send a message with threadId for threaded replies', async () => {
    const result = await client.sendMessage(
      'oc_thread_chat',
      'Reply in thread',
      'om_parent_msg_123',
    );

    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].chatId).toBe('oc_thread_chat');
    expect(capturedMessages[0].text).toBe('Reply in thread');
    expect(capturedMessages[0].threadId).toBe('om_parent_msg_123');
  });

  it('should send a message with @mentions', async () => {
    const mentions = [
      { openId: 'ou_user_a', name: 'Alice' },
      { openId: 'ou_user_b', name: 'Bob' },
    ];
    const result = await client.sendMessage(
      'oc_mention_chat',
      '@Alice @Bob please review',
      undefined,
      mentions,
    );

    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].mentions).toEqual(mentions);
  });

  it('should send multiple messages in sequence', async () => {
    const messages = [
      { chatId: 'oc_chat_1', text: 'First message' },
      { chatId: 'oc_chat_1', text: 'Second message' },
      { chatId: 'oc_chat_2', text: 'Different chat' },
    ];

    for (const msg of messages) {
      const result = await client.sendMessage(msg.chatId, msg.text);
      expect(result.success).toBe(true);
    }

    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0].text).toBe('First message');
    expect(capturedMessages[1].text).toBe('Second message');
    expect(capturedMessages[2].chatId).toBe('oc_chat_2');
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
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const errorHandler = createInteractiveMessageHandler(() => {}, errorContainer);
    const errorServer = new UnixSocketIpcServer(errorHandler, { socketPath: errorSocketPath });
    const errorClient = new UnixSocketIpcClient({ socketPath: errorSocketPath, timeout: 2000 });

    try {
      await errorServer.start();
      await errorClient.connect();

      const result = await errorClient.sendMessage('oc_test', 'Trigger error');

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit exceeded');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle messages with special characters and long text', async () => {
    const specialText = '特殊字符: <>&"\'\\n\\t 以及中文 🎉 emoji 🚀';
    const result = await client.sendMessage('oc_special_chat', specialText);

    expect(result.success).toBe(true);
    expect(capturedMessages[0].text).toBe(specialText);
  });

  it('should handle empty text message', async () => {
    const result = await client.sendMessage('oc_empty_chat', '');

    expect(result.success).toBe(true);
    expect(capturedMessages[0].text).toBe('');
  });

  it('should preserve all parameters together (text + threadId + mentions)', async () => {
    const mentions = [{ openId: 'ou_reviewer', name: 'Reviewer' }];
    const result = await client.sendMessage(
      'oc_full_chat',
      '@Reviewer please check this PR',
      'om_thread_456',
      mentions,
    );

    expect(result.success).toBe(true);
    const captured = capturedMessages[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.text).toBe('@Reviewer please check this PR');
    expect(captured.threadId).toBe('om_thread_456');
    expect(captured.mentions).toEqual(mentions);
  });
});
