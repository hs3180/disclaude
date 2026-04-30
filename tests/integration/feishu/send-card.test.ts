/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending, thread support, description metadata,
 * card structure validation, and error handling through the real Unix socket
 * IPC transport layer.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
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
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
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
    const card = createTestCard();
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card).toEqual(card);
  });

  it('should send a card with threadId for threaded context', async () => {
    const card = createTestCard({
      header: { title: { content: 'Threaded Card', tag: 'plain_text' } },
    });
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
  });

  it('should send a card with description metadata', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Status update card');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Status update card');
    expect(capturedCards[0].threadId).toBeUndefined();
  });

  it('should send a card with all parameters', async () => {
    const card = createTestCard({
      elements: [
        { tag: 'markdown', content: '**Bold text** and `code`' },
        { tag: 'hr' },
        { tag: 'action', actions: [
          { tag: 'button', text: { content: 'Click me', tag: 'plain_text' }, value: 'click', type: 'primary' },
        ] },
      ],
    });

    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_789',
      'Full-featured card',
    );

    expect(result.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_full_chat');
    expect(capturedCards[0].threadId).toBe('om_thread_789');
    expect(capturedCards[0].description).toBe('Full-featured card');
    expect(capturedCards[0].card.elements).toHaveLength(3);
  });

  it('should send multiple cards to different chats independently', async () => {
    const cardA = createTestCard({
      header: { title: { content: 'Card A', tag: 'plain_text' } },
    });
    const cardB = createTestCard({
      header: { title: { content: 'Card B', tag: 'plain_text' } },
    });

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

  it('should send a complex card with multiple element types', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'CI Pipeline Report', tag: 'plain_text' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: '✅ **Build**: Passed\n✅ **Tests**: 124/124 passed' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'Coverage: 78.5% (+2.3%)' },
        { tag: 'action', actions: [
          { tag: 'button', text: { content: 'View Report', tag: 'plain_text' }, value: 'view_report', type: 'primary' },
          { tag: 'button', text: { content: 'Download Logs', tag: 'plain_text' }, value: 'download_logs' },
        ] },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(true);
    expect(capturedCards[0].card.header.template).toBe('green');
    expect(capturedCards[0].card.elements).toHaveLength(4);
  });

  it('should preserve card config with update_mode', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: false, update_mode: 'append' },
      header: {
        title: { content: 'Updatable Card', tag: 'plain_text' },
      },
      elements: [
        { tag: 'markdown', content: 'Initial content' },
      ],
    };

    const result = await client.sendCard('oc_update_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.config.update_mode).toBe('append');
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(false);
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
          throw new Error('Card content violates policy');
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
      expect(result.error).toContain('Card content violates policy');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle cards with CJK and special characters in content', async () => {
    const card = createTestCard({
      elements: [
        { tag: 'markdown', content: '中文内容测试 🎉 特殊字符: <>&"\' 以及 emoji 🚀' },
      ],
    });

    const result = await client.sendCard('oc_cjk_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements[0]).toEqual({
      tag: 'markdown',
      content: '中文内容测试 🎉 特殊字符: <>&"\' 以及 emoji 🚀',
    });
  });

  it('should handle card with empty elements array', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Empty Card', tag: 'plain_text' },
      },
      elements: [],
    };

    const result = await client.sendCard('oc_empty_card_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards[0].card.elements).toEqual([]);
  });
});
