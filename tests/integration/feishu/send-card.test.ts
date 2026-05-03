/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending, thread support, complex card structures,
 * and error handling through the real Unix socket IPC transport layer.
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

  /** Create a sample FeishuCard for testing */
  function createSampleCard(overrides?: Partial<FeishuCard>): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Test Card', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        { tag: 'markdown', content: 'Hello from integration test' },
      ],
      ...overrides,
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
    const card = createSampleCard();
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createSampleCard();
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

  it('should send a card with description', async () => {
    const card = createSampleCard();
    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'Deployment status update',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Deployment status update');
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with all parameters (card + threadId + description)', async () => {
    const card = createSampleCard({
      header: {
        title: { content: 'Full Parameter Test', tag: 'plain_text' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: 'Full param card content' },
      ],
    });

    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full parameter card',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Full parameter card');
    expect(captured.card.header).toEqual({
      title: { content: 'Full Parameter Test', tag: 'plain_text' },
      template: 'green',
    });
  });

  it('should send multiple cards in sequence', async () => {
    const cards = [
      createSampleCard({ header: { title: { content: 'Card 1', tag: 'plain_text' } } }),
      createSampleCard({ header: { title: { content: 'Card 2', tag: 'plain_text' } } }),
      createSampleCard({ header: { title: { content: 'Card 3', tag: 'plain_text' } } }),
    ];

    for (const card of cards) {
      const result = await client.sendCard('oc_seq_chat', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header).toEqual({ title: { content: 'Card 1', tag: 'plain_text' } });
    expect(capturedCards[1].card.header).toEqual({ title: { content: 'Card 2', tag: 'plain_text' } });
    expect(capturedCards[2].card.header).toEqual({ title: { content: 'Card 3', tag: 'plain_text' } });
  });

  it('should send cards to different chats independently', async () => {
    const cardA = createSampleCard();
    const cardB = createSampleCard();

    const resultA = await client.sendCard('oc_chat_alpha', cardA);
    const resultB = await client.sendCard('oc_chat_beta', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
  });

  it('should handle complex card with multiple elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: '📊 系统状态报告', tag: 'plain_text' },
        template: 'turquoise',
      },
      elements: [
        { tag: 'markdown', content: '**CPU**: ✅ 45%\n**Memory**: ⚠️ 82%\n**Disk**: ✅ 32%' },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { content: '刷新', tag: 'plain_text' }, value: 'refresh', type: 'primary' },
            { tag: 'button', text: { content: '详情', tag: 'plain_text' }, value: 'details' },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toHaveLength(3);
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(true);
  });

  it('should handle card with special characters in content', async () => {
    const specialCard = createSampleCard({
      elements: [
        { tag: 'markdown', content: '特殊字符: <>&"\'\\n\\t 中文 🎉 emoji 🚀 unicode: café résumé' },
      ],
    });

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements[0]).toEqual({
      tag: 'markdown',
      content: '特殊字符: <>&"\'\\n\\t 中文 🎉 emoji 🚀 unicode: café résumé',
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

      const result = await emptyClient.sendCard('oc_test', createSampleCard());

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
          throw new Error('Card template validation failed: missing header');
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

      const result = await errorClient.sendCard('oc_test', createSampleCard());

      expect(result.success).toBe(false);
      expect(result.error).toContain('validation failed');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle empty card elements array', async () => {
    const emptyCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Empty Card', tag: 'plain_text' },
      },
      elements: [],
    };

    const result = await client.sendCard('oc_empty_card_chat', emptyCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toEqual([]);
  });
});
