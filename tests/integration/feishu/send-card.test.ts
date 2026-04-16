/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including thread support, card structure preservation, description handling,
 * and error handling.
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

describeIfFeishu('IPC sendCard end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let capturedCards: Array<{
    chatId: string;
    card: Record<string, unknown>;
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

  it('should send a card with header and elements', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Test Card Title' },
        template: 'blue',
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Card body content' } },
      ],
    };

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = {
      config: {},
      header: { title: { tag: 'plain_text', content: 'Threaded Card' } },
      elements: [],
    };

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

  it('should send a card with description for logging', async () => {
    const card = {
      config: {},
      header: { title: { tag: 'plain_text', content: 'Described Card' } },
      elements: [],
    };

    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'Task completion summary card',
    );

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].description).toBe('Task completion summary card');
  });

  it('should send a card with all parameters together', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Full Card' },
        template: 'green',
      },
      elements: [
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'OK' }, type: 'primary', value: 'ok' },
          ],
        },
      ],
    };

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
    const cards = [
      {
        config: {},
        header: { title: { tag: 'plain_text', content: 'Card 1' } },
        elements: [],
      },
      {
        config: {},
        header: { title: { tag: 'plain_text', content: 'Card 2' } },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Content' } }],
      },
      {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Card 3' } },
        elements: [],
      },
    ];

    for (const card of cards) {
      const result = await client.sendCard('oc_multi_chat', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    // Verify each card's structure was preserved
    expect((capturedCards[0].card as { header: { title: { content: string } } }).header.title.content).toBe('Card 1');
    expect((capturedCards[1].card as { header: { title: { content: string } } }).header.title.content).toBe('Card 2');
    expect((capturedCards[2].card as { header: { title: { content: string } } }).header.title.content).toBe('Card 3');
  });

  it('should send cards to different chats independently', async () => {
    const cardA = {
      config: {},
      header: { title: { tag: 'plain_text', content: 'Chat A Card' } },
      elements: [],
    };
    const cardB = {
      config: {},
      header: { title: { tag: 'plain_text', content: 'Chat B Card' } },
      elements: [],
    };

    const resultA = await client.sendCard('oc_chat_alpha', cardA);
    const resultB = await client.sendCard('oc_chat_beta', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
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

      const card = {
        config: {},
        header: { title: { tag: 'plain_text', content: 'No Handlers' } },
        elements: [],
      };
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
          throw new Error('Feishu card API error: invalid card template');
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

      const card = {
        config: {},
        header: { title: { tag: 'plain_text', content: 'Error Card' } },
        elements: [],
      };
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid card template');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should preserve complex card structure with nested elements', async () => {
    const complexCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '复杂卡片测试 🎉' },
        template: 'turquoise',
        subtitle: { tag: 'plain_text', content: '子标题' },
      },
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'bisect',
          background_style: 'default',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                { tag: 'markdown', content: '**左列**' },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                { tag: 'markdown', content: '**右列**' },
              ],
            },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '确认' }, type: 'primary', value: 'confirm' },
            { tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'danger', value: 'cancel' },
          ],
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '备注信息' },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(complexCard);
  });
});
