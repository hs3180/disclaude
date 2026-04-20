/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending, including thread support, card structure
 * preservation, error handling, and special characters through the real
 * Unix socket IPC transport layer.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1088 — Detailed error information for sendCard
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

/** Build a simple FeishuCard for testing */
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

  it('should send a card message and return success', async () => {
    const card = buildTestCard('Test Card', 'Hello from card');

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = buildTestCard('Thread Card', 'Reply in thread');

    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description', async () => {
    const card = buildTestCard('Card with Desc', 'Content');
    const description = 'This is a card description for notification';

    const result = await client.sendCard('oc_desc_chat', card, undefined, description);

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe(description);
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with both threadId and description', async () => {
    const card = buildTestCard('Full Card', 'All params');

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
  });

  it('should send multiple cards in sequence', async () => {
    const cardA = buildTestCard('Card A', 'First card');
    const cardB = buildTestCard('Card B', 'Second card');
    const cardC = buildTestCard('Card C', 'Third card');

    const resultA = await client.sendCard('oc_seq_chat', cardA);
    const resultB = await client.sendCard('oc_seq_chat', cardB);
    const resultC = await client.sendCard('oc_other_chat', cardC);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(resultC.success).toBe(true);
    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
    expect(capturedCards[2].chatId).toBe('oc_other_chat');
  });

  it('should preserve complex card structure with multiple elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card**' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: 'Line 1' },
        { tag: 'markdown', content: 'Line 2 with **bold**' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'Footer text' },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(complexCard);
    expect(capturedCards[0].card.elements).toHaveLength(4);
  });

  it('should handle card with special characters in content', async () => {
    const specialCard = buildTestCard(
      'Special: <>&"\'',
      '内容包含特殊字符: \n\t <div>HTML</div> {{template}} 和中文 🎉 emoji 🚀',
    );

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.header.title.content).toBe('Special: <>&"\'');
    expect(capturedCards[0].card.elements[0]).toEqual({
      tag: 'markdown',
      content: '内容包含特殊字符: \n\t <div>HTML</div> {{template}} 和中文 🎉 emoji 🚀',
    });
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

      const card = buildTestCard('Error Test', 'Should fail');
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

      const card = buildTestCard('Error Test', 'Should trigger error');
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('card send failed');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should send cards to different chats independently', async () => {
    const cardAlpha = buildTestCard('Alpha Card', 'For alpha chat');
    const cardBeta = buildTestCard('Beta Card', 'For beta chat');

    const resultAlpha = await client.sendCard('oc_chat_alpha', cardAlpha);
    const resultBeta = await client.sendCard('oc_chat_beta', cardBeta);

    expect(resultAlpha.success).toBe(true);
    expect(resultBeta.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
    expect(capturedCards[0].card.header.title.content).toBe('Alpha Card');
    expect(capturedCards[1].card.header.title.content).toBe('Beta Card');
  });
});
