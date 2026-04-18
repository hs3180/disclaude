/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including card structure pass-through, thread support, description, and error handling.
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

/** Build a minimal valid FeishuCard for testing */
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Test Card' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: 'Hello from integration test' },
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

  it('should send a card with threadId for threaded context', async () => {
    const card = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Threaded Card' }, template: 'green' },
    });
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description for notification text', async () => {
    const card = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Notification Card' }, template: 'orange' },
    });
    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'This is the notification text',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('This is the notification text');
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with both threadId and description', async () => {
    const card = createTestCard();
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
    const cardA = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' },
    });
    const cardB = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'red' },
    });

    const resultA = await client.sendCard('oc_chat_1', cardA);
    const resultB = await client.sendCard('oc_chat_2', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
  });

  it('should preserve complex card structure with nested elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card** with _formatting_' },
        template: 'violet',
      },
      elements: [
        { tag: 'markdown', content: '## Section 1\n- Item 1\n- Item 2' },
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

    const captured = capturedCards[0].card;
    expect(captured.config.update_mode).toBe('replace');
    expect(captured.header.title.tag).toBe('lark_md');
    expect(captured.elements).toHaveLength(3);
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
          throw new Error('Feishu card validation failed: missing header');
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
      expect(result.error).toContain('card validation failed');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should send card with lark_md formatted content', async () => {
    const markdownCard = createTestCard({
      header: {
        title: { tag: 'lark_md', content: '**Deployment Report**' },
        template: 'turquoise',
      },
      elements: [
        {
          tag: 'markdown',
          content:
            '**Status**: ✅ Success\n**Version**: v2.3.1\n**Duration**: 3m 42s\n**Commits**: 5',
        },
      ],
    });

    const result = await client.sendCard('oc_md_chat', markdownCard);
    expect(result.success).toBe(true);

    const captured = capturedCards[0].card;
    expect(captured.header.title.tag).toBe('lark_md');
    expect(captured.header.title.content).toBe('**Deployment Report**');
  });
});
