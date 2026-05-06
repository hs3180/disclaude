/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending, thread support, description metadata,
 * wide-screen mode, and error handling through the real Unix socket IPC
 * transport layer.
 *
 * Uses mock IPC handlers — no real Feishu credentials needed.
 * Runs as part of the standard test suite.
 *
 * @see Issue #1626
 * @see Issue #1088 — sendCard detailed error information
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import type { FeishuCard } from '@disclaude/core';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/** Build a simple Feishu card for testing */
function createTestCard(title: string, content: string): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
}

describe('IPC sendCard end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let capturedCards: Array<{
    chatId: string;
    card: FeishuCard;
    threadId?: string;
    description?: string;
  }>;

  /** Create a mock container that captures sendCard calls */
  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async () => {},
        sendCard: async (chatId, card, threadId?, description?) => {
          capturedCards.push({ chatId, card, threadId, description });
        },
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedCards = [];

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

  it('should send a card message and return success', async () => {
    const card = createTestCard('Test Card', 'Hello from integration test');

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard('Thread Card', 'Reply in thread');

    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description metadata', async () => {
    const card = createTestCard('Card with Desc', 'Content here');

    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'This is a notification card',
    );

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].description).toBe('This is a notification card');
  });

  it('should send a card with all parameters (card + threadId + description)', async () => {
    const card = createTestCard('Full Card', 'All parameters');

    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full parameter card',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.card).toEqual(card);
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Full parameter card');
  });

  it('should send multiple cards in sequence', async () => {
    const cardA = createTestCard('Card A', 'First card');
    const cardB = createTestCard('Card B', 'Second card');

    const resultA = await client.sendCard('oc_chat_1', cardA);
    const resultB = await client.sendCard('oc_chat_1', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);

    expect((capturedCards[0].card as FeishuCard).header).toBeDefined();
    expect((capturedCards[1].card as FeishuCard).header).toBeDefined();
  });

  it('should send cards to different chats independently', async () => {
    const card = createTestCard('Multi Chat', 'Same card, different chats');

    const result1 = await client.sendCard('oc_chat_alpha', card);
    const result2 = await client.sendCard('oc_chat_beta', card);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
  });

  it('should send a complex card with multiple elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Complex Card' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: 'Section 1' },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Confirm' },
              type: 'primary',
              value: { action: 'confirm' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Cancel' },
              type: 'danger',
              value: { action: 'cancel' },
            },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: 'Footer note' }] },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(complexCard);
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

      const card = createTestCard('Error Test', 'Should fail');
      const result = await emptyClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(emptySocketPath);
    }
  });

  it('should return error when sendCard handler throws', async () => {
    const errorSocketPath = generateSocketPath();
    const errorContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {
          throw new Error('Feishu card API error: invalid card format');
        },
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

      const card = createTestCard('Error Trigger', 'Will cause error');
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid card format');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle card with special characters in content', async () => {
    const card = createTestCard(
      '特殊字符测试',
      '包含: <>&"\' 以及中文 🎉 emoji 🚀 和换行\n新行',
    );

    const result = await client.sendCard('oc_special_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(card);
  });
});
