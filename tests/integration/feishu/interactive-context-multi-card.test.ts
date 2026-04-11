/**
 * P0 Integration test: InteractiveContextStore multi-card coexistence (#1625).
 *
 * Verifies the fix for Issue #1625 where action prompts from different cards
 * in the same chat would overwrite each other. Tests the full IPC chain:
 *
 *   Card A sent via IPC → actionPrompts registered
 *   Card B sent via IPC → actionPrompts registered
 *   Callback for Card A action → should resolve to Card A's prompt (not B's)
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1625 — IPC sendInteractive actionPrompts overwrite bug
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { InteractiveContextStore } from '@disclaude/primary-node';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('InteractiveContextStore multi-card coexistence (#1625)', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let store: InteractiveContextStore;
  let messageIdCounter: number;

  /** Create a mock sendInteractive handler that returns unique messageIds */
  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async (_chatId, _params) => {
          messageIdCounter++;
          return { messageId: `om_card_${messageIdCounter}` };
        },
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    store = new InteractiveContextStore();
    messageIdCounter = 0;

    const container = createMockContainer();

    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

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
      store.clear();
    }
  });

  it('should keep action prompts from Card A when Card B is sent to the same chat', async () => {
    // Card A: IPC script sends a knowledge-question card
    const resultA = await client.sendInteractive('oc_group_chat', {
      question: '您想了解哪个话题？',
      options: [
        { text: 'AI 解释', value: 'explain_ai' },
        { text: 'AI 应用', value: 'ai_applications' },
        { text: 'AI 历史', value: 'ai_history' },
      ],
      title: '知识问答',
      actionPrompts: {
        explain_ai: '[用户操作] 用户想了解AI解释',
        ai_applications: '[用户操作] 用户想看AI应用',
        ai_history: '[用户操作] 用户想看AI历史',
      },
    });

    expect(resultA.success).toBe(true);
    expect(resultA.messageId).toBe('om_card_1');

    // Card B: Agent sends a confirmation card to the SAME chat
    const resultB = await client.sendInteractive('oc_group_chat', {
      question: '确认执行此操作？',
      options: [
        { text: '确认', value: 'yes', type: 'primary' },
        { text: '取消', value: 'no', type: 'danger' },
      ],
      title: '操作确认',
      actionPrompts: {
        yes: '[用户操作] 用户确认了',
        no: '[用户操作] 用户拒绝了',
      },
    });

    expect(resultB.success).toBe(true);
    expect(resultB.messageId).toBe('om_card_2');
    expect(store.size).toBe(2);

    // Both cards should be independently retrievable
    const promptsA = store.getActionPrompts('om_card_1');
    expect(promptsA).toBeDefined();
    expect(promptsA?.explain_ai).toBe('[用户操作] 用户想了解AI解释');

    const promptsB = store.getActionPrompts('om_card_2');
    expect(promptsB).toBeDefined();
    expect(promptsB?.yes).toBe('[用户操作] 用户确认了');

    // Simulate callback: user clicks Card A's "AI 解释" button
    // Feishu might send a different messageId, so we test via chatId + actionValue
    const prompt = store.generatePrompt(
      'unknown_feishu_id', // unknown messageId
      'oc_group_chat',
      'explain_ai', // belongs to Card A, not Card B
      'AI 解释',
    );
    expect(prompt).toBe('[用户操作] 用户想了解AI解释');
  });

  it('should resolve Card B action even when Card A was sent last registered', async () => {
    // Send Card B first (older)
    await client.sendInteractive('oc_group_chat', {
      question: 'B question',
      options: [{ text: 'B action', value: 'b_action' }],
      actionPrompts: { b_action: 'Card B was clicked' },
    });

    // Send Card A second (newer — would be the chatId fallback target)
    await client.sendInteractive('oc_group_chat', {
      question: 'A question',
      options: [{ text: 'A action', value: 'a_action' }],
      actionPrompts: { a_action: 'Card A was clicked' },
    });

    // chatId fallback should return Card A (newest)
    const fallbackPrompts = store.getActionPromptsByChatId('oc_group_chat');
    expect(fallbackPrompts?.a_action).toBe('Card A was clicked');

    // But Card B's action should still be findable via cross-card search
    const bPrompt = store.findActionPromptsByChatId('oc_group_chat', 'b_action');
    expect(bPrompt).toBeDefined();
    expect(bPrompt?.b_action).toBe('Card B was clicked');
  });

  it('should handle LRU eviction correctly with multiple cards', async () => {
    // Use a store with max 3 entries per chat
    const limitedStore = new InteractiveContextStore(24 * 60 * 60 * 1000, 3);
    const limitedContainer = createMockContainer();

    const limitedHandler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        limitedStore.register(messageId, chatId, actionPrompts);
      },
      limitedContainer,
    );

    const limitedSocketPath = generateSocketPath();
    const limitedServer = new UnixSocketIpcServer(limitedHandler, { socketPath: limitedSocketPath });
    const limitedClient = new UnixSocketIpcClient({ socketPath: limitedSocketPath, timeout: 5000 });

    try {
      await limitedServer.start();
      await limitedClient.connect();

      // Send 4 cards (max is 3, so card 1 should be evicted)
      for (let i = 1; i <= 4; i++) {
        await limitedClient.sendInteractive('oc_group_chat', {
          question: `Card ${i}`,
          options: [{ text: `Action ${i}`, value: `action_${i}` }],
          actionPrompts: { [`action_${i}`]: `Card ${i} clicked` },
        });
      }

      // Only 3 entries should remain
      expect(limitedStore.size).toBe(3);

      // Card 1 should be evicted
      expect(limitedStore.getActionPrompts('om_card_1')).toBeUndefined();

      // Cards 2-4 should still exist
      expect(limitedStore.getActionPrompts('om_card_2')).toBeDefined();
      expect(limitedStore.getActionPrompts('om_card_3')).toBeDefined();
      expect(limitedStore.getActionPrompts('om_card_4')).toBeDefined();
    } finally {
      await limitedClient.disconnect().catch(() => {});
      await limitedServer.stop().catch(() => {});
      cleanupSocket(limitedSocketPath);
      limitedStore.clear();
    }
  });

  it('should handle form data placeholders across multiple cards', async () => {
    // Card A: form-based card
    await client.sendInteractive('oc_group_chat', {
      question: '请提交反馈',
      options: [{ text: '提交', value: 'submit_feedback', type: 'primary' }],
      actionPrompts: {
        submit_feedback: '用户提交了反馈: {{form.rating}}/5 - {{form.comment}}',
      },
    });

    // Card B: simple card
    await client.sendInteractive('oc_group_chat', {
      question: '关闭对话框？',
      options: [{ text: '关闭', value: 'dismiss' }],
      actionPrompts: { dismiss: '用户关闭了对话框' },
    });

    // Callback with form data from Card A
    const prompt = store.generatePrompt(
      'unknown',
      'oc_group_chat',
      'submit_feedback',
      undefined,
      undefined,
      { rating: '4', comment: '很好用' },
    );

    expect(prompt).toBe('用户提交了反馈: 4/5 - 很好用');

    // Card B's action should still work
    const dismissPrompt = store.generatePrompt('unknown', 'oc_group_chat', 'dismiss', '关闭');
    expect(dismissPrompt).toBe('用户关闭了对话框');
  });
});
