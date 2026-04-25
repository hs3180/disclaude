/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including card structure preservation, thread support, description passing,
 * and error handling.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
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
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('IPC sendCard end-to-end chain', () => {
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

  /** A simple Feishu card for testing */
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

  it('should send a card and return success', async () => {
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
    const card = createTestCard('Threaded Card', 'Reply in thread');
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send a card with description', async () => {
    const card = createTestCard('Deployment Status', 'Deploying to production...');
    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'Deployment progress notification',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Deployment progress notification');
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with both threadId and description', async () => {
    const card = createTestCard('Full Card', 'All parameters');
    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full parameter test',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_full_chat');
    expect(capturedCards[0].threadId).toBe('om_thread_789');
    expect(capturedCards[0].description).toBe('Full parameter test');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send multiple cards in sequence', async () => {
    const cards = [
      { chatId: 'oc_chat_1', card: createTestCard('Card 1', 'First card') },
      { chatId: 'oc_chat_1', card: createTestCard('Card 2', 'Second card') },
      { chatId: 'oc_chat_2', card: createTestCard('Card 3', 'Different chat') },
    ];

    for (const { chatId, card } of cards) {
      const result = await client.sendCard(chatId, card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card 1');
    expect(capturedCards[1].card.header.title.content).toBe('Card 2');
    expect(capturedCards[2].chatId).toBe('oc_chat_2');
  });

  it('should preserve complex card structure with nested elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'plain_text', content: 'Complex Card' },
        template: 'green',
      },
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{ tag: 'markdown', content: '**Left column**' }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{ tag: 'markdown', content: '**Right column**' }],
            },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: 'Footer note' }],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(complexCard);
  });

  it('should preserve card with special characters in content', async () => {
    const specialCard = createTestCard(
      '特殊字符测试',
      '内容: <>&"\'\\n 以及中文 🎉 emoji 🚀\n换行测试',
    );

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(specialCard);
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

      const result = await emptyClient.sendCard('oc_test', createTestCard('Q', 'Content'));

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
          throw new Error('Card rendering failed: invalid template');
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

      const result = await errorClient.sendCard('oc_test', createTestCard('Error', 'Test'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Card rendering failed');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });
});
