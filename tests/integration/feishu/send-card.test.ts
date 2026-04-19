/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including thread support, description, error handling, and various card payloads.
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
function createTestCard(title: string, content: string): FeishuCard {
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
    const card = createTestCard('Test Card', 'Hello from integration test');

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card.header.title.content).toBe('Test Card');
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard('Thread Reply', 'Replying in thread');

    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description', async () => {
    const card = createTestCard('Status Report', 'All systems operational');

    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Daily status update');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Daily status update');
  });

  it('should send a card with both threadId and description', async () => {
    const card = createTestCard('Full Card', 'Complete parameters');

    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Card with all parameters',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Card with all parameters');
  });

  it('should send a complex card with multiple elements', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card**' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: '## Section 1\nFirst section content' },
        { tag: 'markdown', content: '## Section 2\nSecond section content' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'Footer content' },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toHaveLength(4);
  });

  it('should send multiple cards in sequence', async () => {
    const cards = [
      createTestCard('Card 1', 'First card'),
      createTestCard('Card 2', 'Second card'),
      createTestCard('Card 3', 'Third card'),
    ];

    for (const card of cards) {
      const result = await client.sendCard('oc_multi_card', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card 1');
    expect(capturedCards[1].card.header.title.content).toBe('Card 2');
    expect(capturedCards[2].card.header.title.content).toBe('Card 3');
  });

  it('should send cards to different chats independently', async () => {
    const cardA = createTestCard('Chat A', 'Content for chat A');
    const cardB = createTestCard('Chat B', 'Content for chat B');

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

      const card = createTestCard('Error Test', 'Should fail');
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

      const card = createTestCard('Large Card', 'x'.repeat(10000));
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('card content too large');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should preserve card with special characters in content', async () => {
    const specialCard = createTestCard(
      '特殊字符: <>&"\'\\n\\t',
      '中文内容 🎉 emoji 🚀 特殊: <script>alert("xss")</script>',
    );

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.header.title.content).toContain('特殊字符');
    expect(capturedCards[0].card.elements[0]).toBeDefined();
  });

  it('should handle card with empty elements array', async () => {
    const emptyCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Empty Body Card' },
        template: 'grey',
      },
      elements: [],
    };

    const result = await client.sendCard('oc_empty_card_chat', emptyCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toHaveLength(0);
  });
});
