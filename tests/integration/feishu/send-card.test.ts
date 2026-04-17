/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including card structure preservation, thread support, description, and error handling.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1574 — Phase 5 of IPC refactor (platform-agnostic messaging)
 * @see Issue #1088 — sendCard error information
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
function makeCard(overrides?: Partial<FeishuCard>): FeishuCard {
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

  it('should send a card message and return success', async () => {
    const card = makeCard();
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded reply', async () => {
    const card = makeCard({
      header: { title: { tag: 'plain_text', content: 'Thread Reply Card' }, template: 'green' },
    });
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
    expect(capturedCards[0].card.header.title.content).toBe('Thread Reply Card');
  });

  it('should send a card with description', async () => {
    const card = makeCard();
    const result = await client.sendCard('oc_desc_chat', card, undefined, '部署状态更新');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('部署状态更新');
  });

  it('should send a card with all parameters together', async () => {
    const card = makeCard({
      config: { wide_screen_mode: false },
      header: { title: { tag: 'lark_md', content: '**Full Card Test**' }, template: 'red' },
      elements: [
        { tag: 'markdown', content: 'Line 1' },
        { tag: 'markdown', content: 'Line 2' },
        { tag: 'hr' },
        { tag: 'action', actions: [] },
      ],
    });
    const result = await client.sendCard('oc_full_chat', card, 'om_thread_789', 'Full param test');

    expect(result.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_full_chat');
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(false);
    expect(capturedCards[0].card.header.title.tag).toBe('lark_md');
    expect(capturedCards[0].card.elements).toHaveLength(4);
    expect(capturedCards[0].threadId).toBe('om_thread_789');
    expect(capturedCards[0].description).toBe('Full param test');
  });

  it('should send multiple cards in sequence', async () => {
    const cards = [
      makeCard({ header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' } }),
      makeCard({ header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'green' } }),
      makeCard({ header: { title: { tag: 'plain_text', content: 'Card C' }, template: 'red' } }),
    ];

    for (const card of cards) {
      const result = await client.sendCard('oc_multi_chat', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
    expect(capturedCards[2].card.header.title.content).toBe('Card C');
  });

  it('should send cards to different chats independently', async () => {
    const cardA = makeCard({ header: { title: { tag: 'plain_text', content: 'For Chat A' }, template: 'blue' } });
    const cardB = makeCard({ header: { title: { tag: 'plain_text', content: 'For Chat B' }, template: 'orange' } });

    const resultA = await client.sendCard('oc_chat_alpha', cardA);
    const resultB = await client.sendCard('oc_chat_beta', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
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

      const result = await emptyClient.sendCard('oc_test', makeCard());

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
          throw new Error('Card template validation failed');
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

      const result = await errorClient.sendCard('oc_test', makeCard());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Card template validation failed');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should preserve complex card structure with nested elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card** with _markdown_' },
        template: 'violet',
        subtitle: { tag: 'plain_text', content: 'Subtitle text' },
      },
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{ tag: 'markdown', content: 'Left column' }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{ tag: 'markdown', content: 'Right column' }],
            },
          ],
        },
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
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: 'Footer note' },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard, undefined, 'Complex structure test');
    expect(result.success).toBe(true);

    // Verify the full card structure was preserved through IPC serialization
    const captured = capturedCards[0];
    expect(captured.card.config.update_mode).toBe('replace');
    expect(captured.card.elements).toHaveLength(4);
    expect((captured.card.elements[0] as Record<string, unknown>).tag).toBe('column_set');
    expect((captured.card.elements[2] as Record<string, unknown>).tag).toBe('action');
    expect(captured.description).toBe('Complex structure test');
  });
});
