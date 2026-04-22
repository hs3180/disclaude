/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including thread support, description metadata, error handling, and complex
 * card structures (wide screen mode, markdown elements).
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

/** Minimal FeishuCard shape for testing (matches the interface from @disclaude/core). */
interface TestFeishuCard {
  config: { wide_screen_mode?: boolean; [key: string]: unknown };
  header: {
    title: { tag: string; content: string };
    template?: string;
    [key: string]: unknown;
  };
  elements: unknown[];
  [key: string]: unknown;
}

/** Helper to create a simple test card. */
function createTestCard(overrides?: Partial<TestFeishuCard>): TestFeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Test Card' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: 'Hello from test card **markdown**' },
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
    card: TestFeishuCard;
    threadId?: string;
    description?: string;
  }>;

  /** Create a mock container that captures sendCard calls. */
  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async () => {},
        sendCard: async (chatId, card, threadId?, description?) => {
          capturedCards.push({ chatId, card: card as TestFeishuCard, threadId, description });
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
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_123');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].threadId).toBe('om_parent_msg_123');
  });

  it('should send a card with description metadata', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Deployment status card');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].description).toBe('Deployment status card');
  });

  it('should send a card with all parameters (card + threadId + description)', async () => {
    const card = createTestCard({
      header: { title: { tag: 'lark_md', content: '**Full Params**' }, template: 'green' },
      elements: [
        { tag: 'markdown', content: 'Line 1\nLine 2' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'After divider' },
      ],
    });

    const result = await client.sendCard('oc_full_chat', card, 'om_thread_456', 'Full params test');

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.card.header.title.content).toBe('**Full Params**');
    expect(captured.card.header.template).toBe('green');
    expect(captured.threadId).toBe('om_thread_456');
    expect(captured.description).toBe('Full params test');
    expect(captured.card.elements).toHaveLength(3);
  });

  it('should send multiple cards in sequence', async () => {
    const cardA = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' } });
    const cardB = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'red' } });

    const resultA = await client.sendCard('oc_chat_1', cardA);
    const resultB = await client.sendCard('oc_chat_2', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCards).toHaveLength(2);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
    expect(capturedCards[0].chatId).toBe('oc_chat_1');
    expect(capturedCards[1].chatId).toBe('oc_chat_2');
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
          throw new Error('Feishu API rate limit exceeded');
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
      expect(result.error).toContain('rate limit exceeded');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should preserve complex card elements through the IPC chain', async () => {
    const complexCard: TestFeishuCard = {
      config: {
        wide_screen_mode: true,
        update_mode: 'replace',
      },
      header: {
        title: { tag: 'lark_md', content: '**Complex Card**' },
        template: 'turquoise',
        UdIcon: { icon: 'icon_star' },
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: 'Status: **Running**' },
        },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'stretch',
          background_style: 'default',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                { tag: 'markdown', content: '**Metric A**: 42' },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                { tag: 'markdown', content: '**Metric B**: 99' },
              ],
            },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Refresh' },
              type: 'primary',
              value: { action: 'refresh' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Dismiss' },
              value: { action: 'dismiss' },
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    const captured = capturedCards[0].card;

    // Verify config
    expect(captured.config.wide_screen_mode).toBe(true);
    expect(captured.config.update_mode).toBe('replace');

    // Verify header
    expect(captured.header.title.content).toBe('**Complex Card**');
    expect(captured.header.template).toBe('turquoise');

    // Verify elements structure
    expect(captured.elements).toHaveLength(5);
    const columnSet = captured.elements[2] as Record<string, unknown>;
    expect(columnSet.tag).toBe('column_set');
    expect((columnSet.columns as unknown[])).toHaveLength(2);

    // Verify action buttons
    const action = captured.elements[4] as Record<string, unknown>;
    expect(action.tag).toBe('action');
    expect((action.actions as unknown[])).toHaveLength(2);
  });

  it('should send cards to different chats independently', async () => {
    const card1 = createTestCard({ header: { title: { tag: 'plain_text', content: 'Alpha Card' } } });
    const card2 = createTestCard({ header: { title: { tag: 'plain_text', content: 'Beta Card' } } });

    const result1 = await client.sendCard('oc_chat_alpha', card1);
    const result2 = await client.sendCard('oc_chat_beta', card2);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(capturedCards[0].chatId).toBe('oc_chat_alpha');
    expect(capturedCards[1].chatId).toBe('oc_chat_beta');
    expect(capturedCards[0].card.header.title.content).toBe('Alpha Card');
    expect(capturedCards[1].card.header.title.content).toBe('Beta Card');
  });
});
