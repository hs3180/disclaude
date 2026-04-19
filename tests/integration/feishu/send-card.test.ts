/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including complex card structures, thread support, descriptions, and error handling.
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

/** Create a sample Feishu card for testing */
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Test Card' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: 'This is a test card' },
    ],
    ...overrides,
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
    const card = createTestCard();
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Thread Reply Card' }, template: 'green' },
    });
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Fallback notification text');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Fallback notification text');
  });

  it('should send a card with all parameters (card + threadId + description)', async () => {
    const card = createTestCard({
      header: { title: { tag: 'lark_md', content: '**Full Param Card**' }, template: 'red' },
      elements: [
        { tag: 'markdown', content: 'Card with all parameters' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Click' } }] },
      ],
    });
    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full param fallback text',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.card).toEqual(card);
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Full param fallback text');
  });

  it('should send complex card with multiple elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Build Status** `#1234`' },
        template: 'turquoise',
      },
      elements: [
        { tag: 'markdown', content: 'Pipeline: `deploy-production`' },
        { tag: 'markdown', content: 'Status: ✅ **Passed**' },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'View Logs' }, type: 'primary', value: { action: 'logs' } },
            { tag: 'button', text: { tag: 'plain_text', content: 'Rollback' }, type: 'danger', value: { action: 'rollback' } },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: 'Triggered by @alice' }] },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(complexCard);
    expect(capturedCards[0].card.elements).toHaveLength(5);
  });

  it('should send multiple cards to different chats', async () => {
    const cardA = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' },
    });
    const cardB = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'green' },
    });

    const resultA = await client.sendCard('oc_chat_a', cardA);
    const resultB = await client.sendCard('oc_chat_b', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].chatId).toBe('oc_chat_a');
    expect(capturedCards[1].chatId).toBe('oc_chat_b');
  });

  it('should send multiple cards to the same chat', async () => {
    const card1 = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card 1' }, template: 'blue' },
    });
    const card2 = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card 2' }, template: 'red' },
    });

    await client.sendCard('oc_same_chat', card1);
    await client.sendCard('oc_same_chat', card2);

    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].card.header.title.content).toBe('Card 1');
    expect(capturedCards[1].card.header.title.content).toBe('Card 2');
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

      const result = await emptyClient.sendCard('oc_test', createTestCard());

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
          throw new Error('Feishu API error: card content too large');
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

      const result = await errorClient.sendCard('oc_test', createTestCard());

      expect(result.success).toBe(false);
      expect(result.error).toContain('card content too large');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle card with special characters in content', async () => {
    const specialCard = createTestCard({
      header: {
        title: { tag: 'lark_md', content: '特殊字符: <>&"\' 以及中文 🎉 emoji 🚀' },
        template: 'default',
      },
      elements: [
        { tag: 'markdown', content: '路径: `/path/to/file` & "引用"\n换行测试' },
      ],
    });

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.header.title.content).toContain('特殊字符');
    expect(capturedCards[0].card.header.title.content).toContain('🎉');
  });

  it('should handle card with empty elements array', async () => {
    const emptyCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Empty Card' },
        template: 'grey',
      },
      elements: [],
    };

    const result = await client.sendCard('oc_empty_chat', emptyCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toEqual([]);
  });
});
