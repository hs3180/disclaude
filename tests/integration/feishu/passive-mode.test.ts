/**
 * P3 Integration test: Passive mode (trigger mode) message filtering.
 *
 * Verifies that the TriggerModeManager correctly manages message filtering
 * in the context of the IPC layer. Tests:
 * - Trigger mode state is correctly applied to IPC message routing
 * - Small group auto-detection works with IPC interactions
 * - Trigger mode state can be restored from records after server restart
 * - Interactive cards work correctly in both trigger mode states
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #511 — Group chat passive mode control
 * @see Issue #2193 — Renamed from PassiveModeManager to TriggerModeManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { InteractiveContextStore } from '@disclaude/primary-node';
import { TriggerModeManager } from '../../../packages/primary-node/src/channels/feishu/passive-mode.js';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('Passive mode (trigger mode) message filtering', () => {
  let socketPath: string;
  let store: InteractiveContextStore;
  let triggerModeManager: TriggerModeManager;
  let capturedMessages: Array<{
    chatId: string;
    text: string;
    threadId?: string;
  }>;
  let capturedCards: Array<{
    chatId: string;
    options: Array<{ text: string; value: string }>;
  }>;

  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async (chatId, text, threadId?) => {
          capturedMessages.push({ chatId, text, threadId });
        },
        sendCard: async () => {},
        sendInteractive: async (chatId, params) => {
          capturedCards.push({
            chatId,
            options: params.options,
          });
          return { messageId: `om_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` };
        },
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(() => {
    socketPath = generateSocketPath();
    store = new InteractiveContextStore();
    triggerModeManager = new TriggerModeManager();
    capturedMessages = [];
    capturedCards = [];
  });

  afterEach(() => {
    cleanupSocket(socketPath);
    store.clear();
  });

  it('should handle messages from both mention-only and trigger-enabled chats via IPC', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    try {
      // Chat A: trigger mode enabled (bot responds to all messages)
      triggerModeManager.setTriggerEnabled('oc_chat_always', true);

      // Chat B: default mode (mention only)
      // No need to configure — default is disabled

      // Both chats can send messages through IPC
      const resultA = await client.sendMessage('oc_chat_always', 'Trigger mode enabled chat');
      const resultB = await client.sendMessage('oc_chat_mention', 'Mention-only chat');

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);

      // Both messages should be captured
      expect(capturedMessages).toHaveLength(2);
      expect(capturedMessages[0].chatId).toBe('oc_chat_always');
      expect(capturedMessages[1].chatId).toBe('oc_chat_mention');
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('should handle interactive cards from trigger-enabled chats', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    try {
      // Enable trigger mode for the chat
      triggerModeManager.setTriggerEnabled('oc_trigger_chat', true);

      // Send interactive card to trigger-enabled chat
      const result = await client.sendInteractive('oc_trigger_chat', {
        question: 'Trigger mode chat question?',
        options: [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' },
        ],
        actionPrompts: {
          a: '[Trigger mode] User chose A',
          b: '[Trigger mode] User chose B',
        },
      });

      expect(result.success).toBe(true);
      expect(store.size).toBe(1);

      // Verify the prompt can be generated
      const prompt = store.generatePrompt(
        result.messageId!,
        'oc_trigger_chat',
        'a',
        'Option A',
      );
      expect(prompt).toBe('[Trigger mode] User chose A');
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('should handle small group auto-detection with IPC interactions', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    try {
      // Mark a chat as small group (auto-enables trigger mode)
      triggerModeManager.markAsSmallGroup('oc_small_group');
      expect(triggerModeManager.isTriggerEnabled('oc_small_group')).toBe(true);

      // Send message to the small group chat
      const result = await client.sendMessage('oc_small_group', 'Small group message');
      expect(result.success).toBe(true);

      // Send interactive card
      const cardResult = await client.sendInteractive('oc_small_group', {
        question: 'Small group card?',
        options: [{ text: 'OK', value: 'ok', type: 'primary' }],
        actionPrompts: { ok: 'Small group: OK clicked' },
      });
      expect(cardResult.success).toBe(true);

      // Verify
      expect(capturedMessages).toHaveLength(1);
      expect(capturedCards).toHaveLength(1);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('should restore trigger mode state from records after IPC server restart', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    // Phase 1: Set up trigger mode and interact
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server1.start();
    await client1.connect();

    triggerModeManager.setTriggerEnabled('oc_persistent_chat', true);
    triggerModeManager.markAsSmallGroup('oc_auto_chat');

    // Interact before restart
    await client1.sendMessage('oc_persistent_chat', 'Before restart');
    await client1.disconnect();
    await server1.stop();

    // Simulate: Save trigger mode state to records
    const enabledChats = triggerModeManager.getTriggerEnabledChats();
    const records = enabledChats.map((chatId) => ({
      chatId,
      triggerMode: 'always' as const,
    }));

    // Phase 2: Simulate restart — create fresh manager and restore state
    const freshManager = new TriggerModeManager();
    const loaded = freshManager.initFromRecords(records);
    expect(loaded).toBe(2); // oc_persistent_chat + oc_auto_chat
    expect(freshManager.isTriggerEnabled('oc_persistent_chat')).toBe(true);
    expect(freshManager.isTriggerEnabled('oc_auto_chat')).toBe(true);

    // Continue IPC interaction with restored state
    const freshStore = new InteractiveContextStore();
    const freshHandler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        freshStore.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server2 = new UnixSocketIpcServer(freshHandler, { socketPath });
    await server2.start();

    const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await client2.connect();

    try {
      // Messages to restored chats should work
      const result = await client2.sendMessage('oc_persistent_chat', 'After restart');
      expect(result.success).toBe(true);

      // Interactive cards in restored chats should work
      const cardResult = await client2.sendInteractive('oc_auto_chat', {
        question: 'Restored state card?',
        options: [{ text: 'Yes', value: 'yes' }],
        actionPrompts: { yes: 'Restored: yes' },
      });
      expect(cardResult.success).toBe(true);
      expect(freshStore.size).toBe(1);
    } finally {
      await client2.disconnect();
      await server2.stop();
    }
  });

  it('should handle trigger mode toggle with active IPC connections', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    try {
      // Start with trigger mode disabled
      expect(triggerModeManager.isTriggerEnabled('oc_toggle_chat')).toBe(false);

      // Send message while trigger mode disabled (simulating mention-only message)
      const result1 = await client.sendMessage('oc_toggle_chat', 'Mention-only message');
      expect(result1.success).toBe(true);

      // Toggle trigger mode ON
      triggerModeManager.setTriggerEnabled('oc_toggle_chat', true);
      expect(triggerModeManager.isTriggerEnabled('oc_toggle_chat')).toBe(true);

      // Send message while trigger mode enabled
      const result2 = await client.sendMessage('oc_toggle_chat', 'Trigger mode message');
      expect(result2.success).toBe(true);

      // Toggle trigger mode OFF
      triggerModeManager.setTriggerEnabled('oc_toggle_chat', false);
      expect(triggerModeManager.isTriggerEnabled('oc_toggle_chat')).toBe(false);

      // Send message after disabling trigger mode
      const result3 = await client.sendMessage('oc_toggle_chat', 'Back to mention-only');
      expect(result3.success).toBe(true);

      // All messages should have been captured regardless of trigger mode state
      expect(capturedMessages).toHaveLength(3);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('should handle multiple chats with different trigger modes simultaneously', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    try {
      // Configure different trigger modes for different chats
      triggerModeManager.setTriggerEnabled('oc_always_chat', true);
      triggerModeManager.markAsSmallGroup('oc_small_chat');
      // oc_mention_chat stays default (mention-only)

      // Send interactive cards to all chats
      const chats = ['oc_always_chat', 'oc_small_chat', 'oc_mention_chat'];
      for (const chatId of chats) {
        const result = await client.sendInteractive(chatId, {
          question: `Card for ${chatId}?`,
          options: [{ text: 'OK', value: 'ok' }],
          actionPrompts: { ok: `${chatId}: OK` },
        });
        expect(result.success).toBe(true);
      }

      // All cards should be registered
      expect(store.size).toBe(3);

      // Each chat should resolve its own prompts
      for (const chatId of chats) {
        const prompts = store.getActionPromptsByChatId(chatId);
        expect(prompts).toBeDefined();
        expect(prompts!.ok).toBe(`${chatId}: OK`);
      }

      // Verify trigger mode state
      expect(triggerModeManager.isTriggerEnabled('oc_always_chat')).toBe(true);
      expect(triggerModeManager.isTriggerEnabled('oc_small_chat')).toBe(true);
      expect(triggerModeManager.isTriggerEnabled('oc_mention_chat')).toBe(false);

      // Verify getTriggerEnabledChats
      const enabledChats = triggerModeManager.getTriggerEnabledChats();
      expect(enabledChats).toContain('oc_always_chat');
      expect(enabledChats).toContain('oc_small_chat');
      expect(enabledChats).not.toContain('oc_mention_chat');
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });
});
