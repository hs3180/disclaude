/**
 * P2 Integration test: IPC sendCard end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendCard()  →  IPC Server  →  Mock sendCard handler  →  Response
 *
 * Verifies card message sending through the real Unix socket IPC transport layer,
 * including card structure preservation, thread support, description passthrough,
 * and error handling.
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

/** Helper to build a minimal valid FeishuCard for testing. */
function createTestCard(overrides?: Partial<FeishuCard>): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Test Card' },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: 'Hello from test' } },
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

  /** Create a mock container that captures sendCard calls. */
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
    const card = createTestCard();
    const result = await client.sendCard('oc_test_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_test_chat');
    expect(capturedCards[0].card.header.title.content).toBe('Test Card');
    expect(capturedCards[0].threadId).toBeUndefined();
    expect(capturedCards[0].description).toBeUndefined();
  });

  it('should preserve card structure through IPC serialization', async () => {
    const card = createTestCard({
      config: { wide_screen_mode: true, update_mode: 'replace' },
      header: {
        title: { tag: 'lark_md', content: '**Build #42** failed' },
        template: 'red',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: 'Error: timeout after 30s' } },
        { tag: 'hr' },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'View Logs' }, value: 'view_logs', type: 'primary' },
        ]},
      ],
    });

    const result = await client.sendCard('oc_build_chat', card);

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    const captured = capturedCards[0].card;
    expect(captured.config.wide_screen_mode).toBe(true);
    expect(captured.config.update_mode).toBe('replace');
    expect(captured.header.title.tag).toBe('lark_md');
    expect(captured.header.title.content).toBe('**Build #42** failed');
    expect(captured.header.template).toBe('red');
    expect(captured.elements).toHaveLength(3);
    // Verify nested structure survived JSON round-trip
    const actionEl = captured.elements[2] as { tag: string; actions: Array<{ value: string }> };
    expect(actionEl.actions[0].value).toBe('view_logs');
  });

  it('should send a card with threadId for threaded replies', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_thread_chat', card, 'om_parent_msg_123');

    expect(result.success).toBe(true);
    expect(capturedCards).toHaveLength(1);
    expect(capturedCards[0].chatId).toBe('oc_thread_chat');
    expect(capturedCards[0].threadId).toBe('om_parent_msg_123');
  });

  it('should pass description parameter to the handler', async () => {
    const card = createTestCard();
    const result = await client.sendCard('oc_desc_chat', card, undefined, 'Build status notification');

    expect(result.success).toBe(true);
    expect(capturedCards[0].description).toBe('Build status notification');
  });

  it('should send multiple cards in sequence', async () => {
    const cardA = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card A' }, template: 'blue' } });
    const cardB = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card B' }, template: 'green' } });
    const cardC = createTestCard({ header: { title: { tag: 'plain_text', content: 'Card C' }, template: 'red' } });

    const resultA = await client.sendCard('oc_chat_1', cardA);
    const resultB = await client.sendCard('oc_chat_1', cardB);
    const resultC = await client.sendCard('oc_chat_2', cardC);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(resultC.success).toBe(true);
    expect(capturedCards).toHaveLength(3);
    expect(capturedCards[0].card.header.title.content).toBe('Card A');
    expect(capturedCards[1].card.header.title.content).toBe('Card B');
    expect(capturedCards[2].card.header.title.content).toBe('Card C');
    expect(capturedCards[2].chatId).toBe('oc_chat_2');
  });

  it('should send cards to different chats independently', async () => {
    const card = createTestCard();
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

      const card = createTestCard();
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

      const card = createTestCard();
      const result = await errorClient.sendCard('oc_test', card);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit exceeded');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should preserve all parameters together (card + threadId + description)', async () => {
    const card = createTestCard({
      header: { title: { tag: 'plain_text', content: 'Full params' }, template: 'orange' },
    });
    const result = await client.sendCard('oc_full_chat', card, 'om_thread_789', 'Deployment summary');

    expect(result.success).toBe(true);
    const captured = capturedCards[0];
    expect(captured.chatId).toBe('oc_full_chat');
    expect(captured.card.header.title.content).toBe('Full params');
    expect(captured.threadId).toBe('om_thread_789');
    expect(captured.description).toBe('Deployment summary');
  });

  it('should handle cards with complex element structures', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'PR Review' },
        template: 'blue',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '**Author:** @alice\n**Branch:** feature/auth' } },
        { tag: 'hr' },
        { tag: 'div', fields: [
          { is_short: true, text: { tag: 'lark_md', content: '**Added:**\n142' } },
          { is_short: true, text: { tag: 'lark_md', content: '**Removed:**\n38' } },
        ]},
        { tag: 'hr' },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, value: 'approve', type: 'primary' },
          { tag: 'button', text: { tag: 'plain_text', content: 'Request Changes' }, value: 'changes', type: 'danger' },
          { tag: 'button', text: { tag: 'plain_text', content: 'Comment' }, value: 'comment' },
        ]},
      ],
    };

    const result = await client.sendCard('oc_pr_chat', card);

    expect(result.success).toBe(true);
    const captured = capturedCards[0].card;
    expect(captured.elements).toHaveLength(5);
    // Verify the fields array survived JSON round-trip
    const fieldsEl = captured.elements[2] as { tag: string; fields: Array<{ is_short: boolean }> };
    expect(fieldsEl.fields).toHaveLength(2);
    expect(fieldsEl.fields[0].is_short).toBe(true);
    // Verify action buttons survived
    const actionEl = captured.elements[4] as { tag: string; actions: Array<{ value: string; type?: string }> };
    expect(actionEl.actions).toHaveLength(3);
    expect(actionEl.actions[0].type).toBe('primary');
    expect(actionEl.actions[1].type).toBe('danger');
  });

  it('should handle cards with markdown content containing special characters', async () => {
    const card = createTestCard({
      header: { title: { tag: 'lark_md', content: 'JSON Result: `<script>alert("xss")</script>`' }, template: 'red' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '```json\n{"key": "value with \\"quotes\\" & <special>"}\n```' } },
      ],
    });

    const result = await client.sendCard('oc_special_chat', card);

    expect(result.success).toBe(true);
    const captured = capturedCards[0].card;
    expect(captured.header.title.content).toContain('<script>');
    expect(captured.elements[0]).toBeDefined();
  });
});
