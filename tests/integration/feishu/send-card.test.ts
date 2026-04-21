/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending, thread support, description passing,
 * and error handling through the real Unix socket IPC transport layer.
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

  it('should send a card message and return success', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Test Card', tag: 'plain_text' as const },
        template: 'blue',
      },
      elements: [
        { tag: 'markdown' as const, content: 'Hello from integration test' },
      ],
    };

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Threaded Card', tag: 'plain_text' as const },
      },
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

  it('should send a card with description', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Card With Description', tag: 'plain_text' as const },
      },
      elements: [],
    };

    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'A test card description',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('A test card description');
  });

  it('should send a card with all parameters', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Full Card', tag: 'plain_text' as const },
        template: 'green',
      },
      elements: [
        { tag: 'markdown' as const, content: 'Body text' },
        {
          tag: 'action' as const,
          actions: [
            {
              tag: 'button' as const,
              text: { content: 'Click me', tag: 'plain_text' as const },
              type: 'primary',
              value: { action: 'click' },
            },
          ],
        },
      ],
    };

    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full-featured card',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.card).toEqual(card);
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Full-featured card');
  });

  it('should send multiple cards in sequence', async () => {
    const cards = [
      {
        config: { wide_screen_mode: true },
        header: { title: { content: 'Card 1', tag: 'plain_text' as const } },
        elements: [],
      },
      {
        config: { wide_screen_mode: true },
        header: { title: { content: 'Card 2', tag: 'plain_text' as const } },
        elements: [],
      },
      {
        config: { wide_screen_mode: true },
        header: { title: { content: 'Card 3', tag: 'plain_text' as const } },
        elements: [],
      },
    ];

    for (const card of cards) {
      const result = await client.sendCard('oc_multi_chat', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card 1');
    expect(capturedCards[1].card.header.title.content).toBe('Card 2');
    expect(capturedCards[2].card.header.title.content).toBe('Card 3');
  });

  it('should send cards to different chats independently', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { content: 'Shared Card', tag: 'plain_text' as const } },
      elements: [],
    };

    const result1 = await client.sendCard('oc_chat_alpha', card);
    const result2 = await client.sendCard('oc_chat_beta', card);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
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
        config: { wide_screen_mode: true },
        header: { title: { content: 'No Handler', tag: 'plain_text' as const } },
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
          throw new Error('Feishu card API rate limit exceeded');
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
        config: { wide_screen_mode: true },
        header: { title: { content: 'Error Card', tag: 'plain_text' as const } },
        elements: [],
      };
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit exceeded');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle card with special characters in content', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: '特殊字符测试 🎉', tag: 'plain_text' as const },
      },
      elements: [
        {
          tag: 'markdown' as const,
          content: '特殊字符: <>&"\'\\n\\t 以及中文 🚀 emoji',
        },
      ],
    };

    const result = await client.sendCard('oc_special_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should handle card with complex nested structure', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Complex Card', tag: 'plain_text' as const },
        template: 'turquoise',
        subtitle: { content: 'Subtitle', tag: 'plain_text' as const },
      },
      elements: [
        {
          tag: 'column_set' as const,
          flex_mode: 'bisect' as const,
          background_style: 'default' as const,
          columns: [
            {
              tag: 'column' as const,
              width: 'weighted' as const,
              elements: [
                {
                  tag: 'markdown' as const,
                  content: '**Left column**',
                },
              ],
            },
            {
              tag: 'column' as const,
              width: 'weighted' as const,
              elements: [
                {
                  tag: 'markdown' as const,
                  content: '*Right column*',
                },
              ],
            },
          ],
        },
        { tag: 'hr' as const },
        {
          tag: 'note' as const,
          elements: [
            {
              tag: 'plain_text' as const,
              content: 'Note text',
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card).toEqual(card);
  });
});
