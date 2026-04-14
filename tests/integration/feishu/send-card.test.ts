/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler
 *
 * Verifies card message sending works correctly through the IPC layer,
 * including card structure serialization and threadId routing.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626 — Optional Feishu integration tests (default skipped)
 * @see Issue #1574 — Phase 5 of IPC refactor: platform-agnostic messaging
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

/** Helper to create a minimal valid FeishuCard */
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Test Card' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: 'Hello from test' },
    ],
    ...overrides,
  };
}

describeIfFeishu('IPC sendCard end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;

  /** Captured sendCard calls for assertion */
  let capturedCalls: Array<{
    chatId: string;
    card: FeishuCard;
    threadId?: string;
    description?: string;
  }>;

  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async () => {},
        sendCard: async (chatId, card, threadId?, description?) => {
          capturedCalls.push({ chatId, card, threadId, description });
        },
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedCalls = [];

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

  it('should send a card message through IPC', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].chatId).toBe('oc_test_chat');
    expect(capturedCalls[0].card).toEqual(card);
    expect(capturedCalls[0].threadId).toBeUndefined();
    expect(capturedCalls[0].description).toBeUndefined();
  });

  it('should send a card with threadId for threaded card replies', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_test_chat', card, 'om_thread_789');

    expect(result.success).toBe(true);
    expect(capturedCalls[0].threadId).toBe('om_thread_789');
  });

  it('should send a card with description for notification text', async () => {
    const card = createTestCard();
    const result = await client.sendCard(
      'oc_test_chat',
      card,
      undefined,
      'New card notification text',
    );

    expect(result.success).toBe(true);
    expect(capturedCalls[0].description).toBe('New card notification text');
  });

  it('should send a card with both threadId and description', async () => {
    const card = createTestCard();
    const result = await client.sendCard(
      'oc_test_chat',
      card,
      'om_parent',
      'Thread card notification',
    );

    expect(result.success).toBe(true);
    expect(capturedCalls[0].threadId).toBe('om_parent');
    expect(capturedCalls[0].description).toBe('Thread card notification');
  });

  it('should preserve complex card structure through IPC serialization', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**复杂卡片** 测试' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: 'Line 1\nLine 2\nLine 3' },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Click Me' },
              type: 'primary',
              value: { action: 'click' },
            },
          ],
        },
      ],
    };

    const result = await client.sendCard('oc_test_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedCalls[0].card).toEqual(complexCard);
    // Verify nested structure survived IPC round-trip
    expect(capturedCalls[0].card.config.wide_screen_mode).toBe(true);
    expect(capturedCalls[0].card.header?.title.content).toBe('**复杂卡片** 测试');
    expect(capturedCalls[0].card.elements).toHaveLength(3);
  });

  it('should send cards to multiple chats', async () => {
    const cardA = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' },
    });
    const cardB = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'red' },
    });

    const resultA = await client.sendCard('oc_chat_a', cardA);
    const resultB = await client.sendCard('oc_chat_b', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0].chatId).toBe('oc_chat_a');
    expect(capturedCalls[1].chatId).toBe('oc_chat_b');
  });

  it('should return error when sendCard handler is not available', async () => {
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

      const result = await client.sendCard('oc_test', createTestCard());

      // The client's socket is connected to the emptyServer,
      // but we used `client` which is connected to the original server.
      // This test verifies error handling when handlers are undefined.
      // Note: client is connected to the original server, so we need to use emptyClient
      const emptyResult = await emptyClient.sendCard('oc_test', createTestCard());

      expect(emptyResult.success).toBe(false);
      expect(emptyResult.error).toContain('not available');
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(emptySocketPath);
    }
  });

  it('should return error when handler throws', async () => {
    const errorSocketPath = generateSocketPath();
    const errorContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {
          throw new Error('Card content violates policy');
        },
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
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
      expect(result.error).toContain('violates policy');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });
});
