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
 * @see Issue #1088 — sendCard error information enhancement
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

/** Build a simple Feishu card for testing */
function createTestCard(title: string, content: string): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
}

/** Build a complex card with multiple elements */
function createComplexCard(title: string): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'lark_md', content: `**${title}**` },
      template: 'green',
    },
    elements: [
      {
        tag: 'markdown',
        content: 'Line 1 of card body',
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: 'Line 2 of card body',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Action 1' },
            type: 'primary',
            value: { action: 'a1' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Action 2' },
            type: 'default',
            value: { action: 'a2' },
          },
        ],
      },
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

  it('should send a simple card and return success', async () => {
    const card = createTestCard('Test Card', 'Hello from test');

    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card.header.title.content).toBe('Test Card');
    expect(capturedCards[0].card.elements).toHaveLength(1);
  });

  it('should send a card with threadId for threaded context', async () => {
    const card = createTestCard('Threaded Card', 'Reply in thread');

    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should send a card with description', async () => {
    const card = createTestCard('Card with Description', 'Content');

    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'This is a notification card',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('This is a notification card');
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with all parameters (card + threadId + description)', async () => {
    const card = createTestCard('Full Card', 'Full parameters test');

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
    expect(captured.card.header.title.content).toBe('Full Card');
  });

  it('should send a complex card with multiple elements', async () => {
    const card = createComplexCard('Complex Card');

    const result = await client.sendCard('oc_complex_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toHaveLength(4);
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(true);
  });

  it('should send cards to different chats independently', async () => {
    const cardA = createTestCard('Card A', 'Chat A content');
    const cardB = createTestCard('Card B', 'Chat B content');

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
    const card1 = createTestCard('Card 1', 'First message');
    const card2 = createTestCard('Card 2', 'Second message');

    const result1 = await client.sendCard('oc_same_chat', card1);
    const result2 = await client.sendCard('oc_same_chat', card2);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].card.header.title.content).toBe('Card 1');
    expect(capturedCards[1].card.header.title.content).toBe('Card 2');
  });

  it('should preserve card config and header details', async () => {
    const card: FeishuCard = {
      config: {
        wide_screen_mode: false,
        update_mode: 'replace',
      },
      header: {
        title: { tag: 'lark_md', content: '**Bold Title**' },
        template: 'red',
      },
      elements: [
        { tag: 'markdown', content: 'Card body with **markdown**' },
      ],
    };

    const result = await client.sendCard('oc_config_chat', card);

    expect(result.success).toBe(true);
    const capturedCard = capturedCards[0].card;
    expect(capturedCard.config.wide_screen_mode).toBe(false);
    expect(capturedCard.config.update_mode).toBe('replace');
    expect(capturedCard.header.title.tag).toBe('lark_md');
    expect(capturedCard.header.template).toBe('red');
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
          throw new Error('Feishu card API error: invalid card format');
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

      const card = createTestCard('Error Card', 'Trigger error');
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid card format');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle cards with special characters in content', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '特殊字符: <>&"\' 中文 🎉' },
      },
      elements: [
        {
          tag: 'markdown',
          content: 'Emoji 🚀 and unicode: àáâãäå',
        },
      ],
    };

    const result = await client.sendCard('oc_special_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.header.title.content).toContain('特殊字符');
    expect(capturedCards[0].card.header.title.content).toContain('🎉');
  });

  it('should handle an empty card elements array', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Empty Body Card' },
      },
      elements: [],
    };

    const result = await client.sendCard('oc_empty_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toEqual([]);
  });
});
