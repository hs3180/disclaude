/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including thread support, complex card structures, and error handling.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1088 — sendCard error information consistency
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

  /** Create a simple Feishu card for testing */
  function createTestCard(title: string): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { content: title, tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        { tag: 'markdown', content: 'This is a test card message' },
      ],
    };
  }

  /** Create a complex Feishu card with multiple elements */
  function createComplexCard(): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Complex Card', tag: 'plain_text' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: '**Bold text** and `code`' },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { content: 'Action', tag: 'plain_text' }, value: 'action1', type: 'primary' },
          ],
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
    const card = createTestCard('Test Card');
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send a card with threadId for threaded context', async () => {
    const card = createTestCard('Threaded Card');
    const result = await client.sendCard(
      'oc_thread_chat',
      card,
      'om_parent_msg_456',
    );

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send a card with description', async () => {
    const card = createTestCard('Described Card');
    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'Summary of card content',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Summary of card content');
  });

  it('should send a complex card with multiple elements', async () => {
    const card = createComplexCard();
    const result = await client.sendCard('oc_complex_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(true);
    expect(capturedCards[0].card.elements).toHaveLength(3);
    expect(capturedCards[0].card.header.template).toBe('green');
  });

  it('should send multiple cards in sequence', async () => {
    const cards = [
      createTestCard('Card 1'),
      createTestCard('Card 2'),
      createTestCard('Card 3'),
    ];

    for (const card of cards) {
      const result = await client.sendCard('oc_multi_chat', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    expect((capturedCards[0].card.header?.title as { content: string })?.content).toBe('Card 1');
    expect((capturedCards[1].card.header?.title as { content: string })?.content).toBe('Card 2');
    expect((capturedCards[2].card.header?.title as { content: string })?.content).toBe('Card 3');
  });

  it('should send cards to different chats independently', async () => {
    const cardA = createTestCard('Chat A Card');
    const cardB = createTestCard('Chat B Card');

    const resultA = await client.sendCard('oc_chat_alpha', cardA);
    const resultB = await client.sendCard('oc_chat_beta', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
  });

  it('should send a card with all parameters together', async () => {
    const card = createTestCard('Full Card');
    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full parameter test',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Full parameter test');
    expect(captured.card).toEqual(card);
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

      const result = await emptyClient.sendCard('oc_test', createTestCard('Error'));

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
          throw new Error('Feishu API card send failed: invalid card format');
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

      const result = await errorClient.sendCard('oc_test', createTestCard('Error'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid card format');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle a card with special characters in content', async () => {
    const specialCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: '特殊字符: <>&"\'测试 🎉', tag: 'plain_text' },
        template: 'orange',
      },
      elements: [
        { tag: 'markdown', content: '中文内容，特殊符号 <>&"\'\\n以及 emoji 🚀✅' },
      ],
    };

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(specialCard);
  });

  it('should handle a card with empty elements array', async () => {
    const emptyCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Empty Elements Card', tag: 'plain_text' },
      },
      elements: [],
    };

    const result = await client.sendCard('oc_empty_chat', emptyCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toEqual([]);
  });
});
