/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies Feishu card sending through the real Unix socket IPC transport layer,
 * including thread support, card metadata, error handling, and parameter passing.
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

/** Create a simple Feishu card for testing */
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: 'Test Card',
      },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: 'Hello from test',
        },
      },
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
    expect(capturedCards[0].card.header.title.content).toBe('Test Card');
    expect(capturedCards[0].card.config.wide_screen_mode).toBe(true);
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_123');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_123');
  });

  it('should send a card with description', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Card summary text');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Card summary text');
  });

  it('should send a card with threadId and description together', async () => {
    const card = createTestCard();
    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_456',
      'Full card description',
    );

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.threadId).toBe('om_thread_456');
    expect(captured.description).toBe('Full card description');
  });

  it('should send multiple cards in sequence to the same chat', async () => {
    const cardA = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'Content A' } }],
    });
    const cardB = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'green' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'Content B' } }],
    });

    const resultA = await client.sendCard('oc_multi_chat', cardA);
    const resultB = await client.sendCard('oc_multi_chat', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
  });

  it('should send cards to different chats independently', async () => {
    const card = createTestCard();

    const resultA = await client.sendCard('oc_chat_alpha', card);
    const resultB = await client.sendCard('oc_chat_beta', card);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
  });

  it('should preserve complex card elements through IPC', async () => {
    const complexCard: FeishuCard = {
      config: {
        wide_screen_mode: true,
        update_mode: 'replace',
      },
      header: {
        title: {
          tag: 'lark_md',
          content: '**Build Result**',
        },
        template: 'red',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: 'Build **#123** failed with exit code 1.',
          },
        },
        {
          tag: 'hr',
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: 'Triggered by: @Alice',
            },
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: 'View Logs',
              },
              type: 'primary',
              value: 'view_logs',
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: 'Retry',
              },
              value: 'retry_build',
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_build_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    const captured = capturedCards[0].card;
    expect(captured.header.title.content).toBe('**Build Result**');
    expect(captured.header.template).toBe('red');
    expect(captured.elements).toHaveLength(4);
    expect(captured.config.update_mode).toBe('replace');
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
          throw new Error('Card size exceeds 30KB limit');
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
      expect(result.error).toContain('Card size exceeds');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle card with special characters in content', async () => {
    const specialCard = createTestCard({
      header: {
        title: {
          tag: 'plain_text',
          content: '特殊字符: <>&"\'\\n 中文 🎉',
        },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: 'Line 1\nLine 2\n\tTabbed\n**bold** _italic_',
          },
        },
      ],
    });

    const result = await client.sendCard('oc_special_chat', specialCard);

    expect(result.success).toBe(true);
    const captured = capturedCards[0].card;
    expect(captured.header.title.content).toBe('特殊字符: <>&"\'\\n 中文 🎉');
    const element = captured.elements[0] as { text: { content: string } };
    expect(element.text.content).toContain('Line 1\nLine 2');
  });
});
