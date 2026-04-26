/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending, thread support, description parameter,
 * and error handling through the real Unix socket IPC transport layer.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1088 — Return detailed error information for sendCard
 * @see Issue #1574 — Phase 5 of IPC refactor (platform-agnostic messaging)
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

/** Helper to build a simple Feishu card for testing */
function buildTestCard(title: string, content: string): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content },
    ],
  };
}

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
    const card = buildTestCard('Test Card', 'Hello from integration test');
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card.header.title.content).toBe('Test Card');
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = buildTestCard('Thread Card', 'Reply in thread');
    const result = await client.sendCard(
      'oc_thread_chat',
      card,
      'om_parent_msg_456',
    );

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description parameter', async () => {
    const card = buildTestCard('Desc Card', 'With description');
    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'Summary of the card content',
    );

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].description).toBe('Summary of the card content');
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with both threadId and description', async () => {
    const card = buildTestCard('Full Card', 'All params');
    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Card with all parameters',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].threadId).toBe('om_thread_789');
    expect(capturedCards[0].description).toBe('Card with all parameters');
  });

  it('should send multiple cards in sequence', async () => {
    const cardA = buildTestCard('Card A', 'First card');
    const cardB = buildTestCard('Card B', 'Second card');
    const cardC = buildTestCard('Card C', 'Third card');

    const resultA = await client.sendCard('oc_seq_chat', cardA);
    const resultB = await client.sendCard('oc_seq_chat', cardB);
    const resultC = await client.sendCard('oc_seq_chat', cardC);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(resultC.success).toBe(true);
    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
    expect(capturedCards[2].card.header.title.content).toBe('Card C');
  });

  it('should send cards to different chats independently', async () => {
    const card = buildTestCard('Shared Card', 'Sent to multiple chats');

    const resultA = await client.sendCard('oc_chat_alpha', card);
    const resultB = await client.sendCard('oc_chat_beta', card);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
  });

  it('should preserve complex card structure', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card**' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: 'Line 1' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'Line 2' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Click Me' },
              value: 'btn_click',
              type: 'primary',
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(true);
    expect(capturedCards[0].card.config.update_mode).toBe('replace');
    expect(capturedCards[0].card.elements).toHaveLength(4);
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

      const card = buildTestCard('Error Card', 'Should fail');
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
          throw new Error('Feishu API error: card format invalid');
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

      const card = buildTestCard('Error Trigger', 'Will cause API error');
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('card format invalid');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle card with unicode and emoji content', async () => {
    const unicodeCard = buildTestCard(
      'Unicode 测试 🎉',
      '特殊字符: <>&"\' 以及中文 emoji 🚀✅',
    );
    const result = await client.sendCard('oc_unicode_chat', unicodeCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.header.title.content).toBe('Unicode 测试 🎉');
  });
});
