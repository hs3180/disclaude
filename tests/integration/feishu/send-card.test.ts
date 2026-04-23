/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including thread support, description passthrough, and error handling.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1088 — sendCard error information consistency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FeishuCard } from '@disclaude/core';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

/** Helper to create a valid FeishuCard for testing. */
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Test Card' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: 'Hello from test!' },
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
          capturedCards.push({ chatId, card: card as FeishuCard, threadId, description });
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
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Threaded Card' }, template: 'green' },
    });

    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_456');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_456');
  });

  it('should pass description through the IPC chain', async () => {
    const card = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Described Card' }, template: 'red' },
    });

    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Build status report');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Build status report');
  });

  it('should send cards with complex elements', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card**' },
        template: 'orange',
      },
      elements: [
        { tag: 'hr' },
        { tag: 'markdown', content: '## Section 1\nSome details here.' },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Approve' },
              value: 'approve',
              type: 'primary',
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Reject' },
              value: 'reject',
              type: 'danger',
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    const sentCard = capturedCards[0].card;
    expect(sentCard.elements).toHaveLength(4);
    // Verify action buttons are preserved
    const actionElement = sentCard.elements[3] as { tag: string; actions: Array<{ value: string }> };
    expect(actionElement.tag).toBe('action');
    expect(actionElement.actions).toHaveLength(2);
    expect(actionElement.actions[0].value).toBe('approve');
    expect(actionElement.actions[1].value).toBe('reject');
  });

  it('should send multiple cards to different chats independently', async () => {
    const cardA = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' } });
    const cardB = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'green' } });

    await client.sendCard('oc_chat_alpha', cardA);
    await client.sendCard('oc_chat_beta', cardB);

    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
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
          throw new Error('Feishu API card size exceeds limit');
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
      expect(result.error).toContain('card size exceeds limit');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle cards with all header template colors', async () => {
    const templates = ['blue', 'red', 'green', 'orange', 'violet', 'indigo', 'grey', 'yellow', 'turquoise', 'wathet'] as const;

    for (const template of templates) {
      const card = createTestCard({
        header: { title: { tag: 'plain_text', content: `${template} card` }, template },
      });
      const result = await client.sendCard('oc_color_test', card);
      expect(result.success).toBe(true);
    }

    expect(capturedCards).toHaveLength(templates.length);
    for (let i = 0; i < templates.length; i++) {
      expect(capturedCards[i].card.header.template).toBe(templates[i]);
    }
  });
});
