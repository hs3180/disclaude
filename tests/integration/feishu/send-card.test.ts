/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler
 *
 * Verifies card message sending through the IPC layer including
 * various card structures, threadId, description, and error handling.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1574 — Platform-agnostic messaging operations
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

/** Helper to create a simple Feishu card for testing */
function createTestCard(title: string, content: string, template = 'blue'): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
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
  let capturedArgs: {
    chatId?: string;
    card?: FeishuCard;
    threadId?: string;
    description?: string;
  };

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedArgs = {};

    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async (chatId, card, threadId?, description?) => {
          capturedArgs = { chatId, card, threadId, description };
        },
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };

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

  it('should send a basic card and deliver correct args', async () => {
    const card = createTestCard('Test Title', 'Hello from card!');

    const result = await client.sendCard('oc_card_chat', card);

    expect(result.success).toBe(true);
    expect(capturedArgs.chatId).toBe('oc_card_chat');
    expect(capturedArgs.card).toEqual(card);
    expect(capturedArgs.threadId).toBeUndefined();
    expect(capturedArgs.description).toBeUndefined();
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard('Threaded Card', 'Reply in thread');

    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg');

    expect(result.success).toBe(true);
    expect(capturedArgs.threadId).toBe('om_parent_msg');
  });

  it('should send a card with description for accessibility', async () => {
    const card = createTestCard('Status Update', 'Build passed ✅');

    const result = await client.sendCard(
      'oc_desc_chat',
      card,
      undefined,
      'CI build status notification',
    );

    expect(result.success).toBe(true);
    expect(capturedArgs.description).toBe('CI build status notification');
  });

  it('should send a card with both threadId and description', async () => {
    const card = createTestCard('Deployment', 'Deployed to production');

    const result = await client.sendCard(
      'oc_full_chat',
      card,
      'om_thread_123',
      'Deployment notification',
    );

    expect(result.success).toBe(true);
    expect(capturedArgs.threadId).toBe('om_thread_123');
    expect(capturedArgs.description).toBe('Deployment notification');
  });

  it('should preserve complex card structures through IPC', async () => {
    const complexCard: FeishuCard = {
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**PR #42 Review**' },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: '## Changes\n- Fixed bug A\n- Added feature B' },
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
        { tag: 'hr' },
        { tag: 'markdown', content: '_Last updated: 2024-01-01_' },
      ],
    };

    const result = await client.sendCard('oc_complex_chat', complexCard);

    expect(result.success).toBe(true);
    expect(capturedArgs.card).toEqual(complexCard);
    // Verify nested structure is preserved
    expect((capturedArgs.card?.elements[1] as Record<string, unknown>)?.actions).toBeDefined();
  });

  it('should send cards to multiple chats', async () => {
    const cardA = createTestCard('Card A', 'Content A', 'blue');
    const cardB = createTestCard('Card B', 'Content B', 'red');

    const resultA = await client.sendCard('oc_chat_a', cardA);
    const resultB = await client.sendCard('oc_chat_b', cardB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
  });

  it('should return error when channel handlers are not available', async () => {
    const card = createTestCard('Error Test', 'Should fail');
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

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
    const card = createTestCard('Error Test', 'Should fail');
    const errorSocketPath = generateSocketPath();
    const errorContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {
          throw new Error('Card rendering failed: invalid template');
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

      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Card rendering failed');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });
});
