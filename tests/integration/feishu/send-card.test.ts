/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies raw card message sending, thread support, error handling,
 * and card structure preservation through the real Unix socket IPC
 * transport layer.
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
    const card = buildTestCard('Test Card', 'Hello, World!');

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card.header.title.content).toBe('Test Card');
  });

  it('should preserve full card structure through IPC transport', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Bold Title**' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: 'Line 1' },
        { tag: 'markdown', content: 'Line 2' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'Footer' },
      ],
    };

    const result = await client.sendCard('oc_structure_test', card);

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.card.config.wide_screen_mode).toBe(true);
    expect(captured.card.config.update_mode).toBe('replace');
    expect(captured.card.header.title.tag).toBe('lark_md');
    expect(captured.card.header.template).toBe('green');
    expect(captured.card.elements).toHaveLength(4);
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = buildTestCard('Threaded Card', 'Reply in thread');

    const result = await client.sendCard(
      'oc_thread_chat',
      card,
      'om_parent_msg_456',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description', async () => {
    const card = buildTestCard('Card with Description', 'Content');
    const description = 'A brief description of the card for notifications';

    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      description,
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe(description);
  });

  it('should send multiple cards to different chats independently', async () => {
    const cardA = buildTestCard('Card A', 'Content A');
    const cardB = buildTestCard('Card B', 'Content B');

    const resultA = await client.sendCard('oc_chat_alpha', cardA);
    const resultB = await client.sendCard('oc_chat_beta', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
  });

  it('should send multiple cards to the same chat', async () => {
    const card1 = buildTestCard('First Card', 'Content 1');
    const card2 = buildTestCard('Second Card', 'Content 2');

    await client.sendCard('oc_same_chat', card1);
    await client.sendCard('oc_same_chat', card2);

    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].card.header.title.content).toBe('First Card');
    expect(capturedCards[1].card.header.title.content).toBe('Second Card');
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
          throw new Error('Feishu API error: card elements exceed limit');
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

      const card = buildTestCard('Error Trigger', 'Should throw');
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('card elements exceed limit');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle card with special characters in content', async () => {
    const card = buildTestCard(
      '特殊字符: <>&"\'',
      '内容包含：中文 🎉 emoji 🚀 换行\\n和特殊符号 <div>',
    );

    const result = await client.sendCard('oc_special_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.header.title.content).toContain('特殊字符');
    expect(capturedCards[0].card.elements[0]).toHaveProperty('tag', 'markdown');
  });

  it('should preserve all parameters together (card + threadId + description)', async () => {
    const card = buildTestCard('Full Params Card', 'All params');
    const threadId = 'om_thread_789';
    const description = 'Notification preview text';

    const result = await client.sendCard(
      'oc_full_params_chat',
      card,
      threadId,
      description,
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_params_chat');
    expect(captured.threadId).toBe(threadId);
    expect(captured.description).toBe(description);
    expect(captured.card.header.title.content).toBe('Full Params Card');
  });

  it('should handle card with complex nested elements', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Complex Card' },
        template: 'orange',
      },
      elements: [
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Approve' },
              type: 'primary',
              value: { action: 'approve' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Reject' },
              type: 'danger',
              value: { action: 'reject' },
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements[0]).toBeDefined();
  });
});
