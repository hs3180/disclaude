/**
 * P6 Integration test: IPC message filtering end-to-end chain.
 *
 * Tests the full pipeline through real IPC transport:
 *   IPC Client.receiveMessage()  →  Unix Socket  →  IPC Server  →
 *   Real MessageHandler (TriggerModeManager + MentionDetector)  →  Response
 *
 * Validates that trigger mode and mention detection filtering work correctly
 * when messages travel through the real IPC transport layer, using the
 * actual MessageHandler code path (not mocked internals).
 *
 * Uses mock channel handlers — no real Feishu credentials needed.
 * Runs as part of the standard test suite.
 *
 * @see Issue #1626 — Feishu IPC integration tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
  FeishuMessageHandler,
  TriggerModeManager,
  MentionDetector,
  InteractionManager,
} from '@disclaude/primary-node';
import type { IncomingMessage, FeishuEventData } from '@disclaude/core';
import { generateSocketPath, cleanupSocket } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let msgCounter = 0;

/** Build a Feishu text message event for a group chat. */
function groupTextEvent(
  chatId: string,
  text: string,
  options?: {
    mentions?: Array<{ key: string; open_id: string; name: string }>;
    chatType?: 'p2p' | 'group' | 'topic';
  },
): Record<string, unknown> {
  const mentions = options?.mentions?.map((m) => ({
    key: m.key,
    id: { open_id: m.open_id, union_id: `un_${m.open_id}`, user_id: `uid_${m.open_id}` },
    name: m.name,
    tenant_key: 'tenant_001',
  }));

  return {
    event: {
      message: {
        message_id: `msg_filter_${++msgCounter}`,
        chat_id: chatId,
        chat_type: options?.chatType ?? 'group',
        content: JSON.stringify({ text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions,
        parent_id: undefined,
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_test_user' },
      },
    },
  };
}

/** Build a Feishu text message event for a P2P chat. */
function p2pTextEvent(text: string): Record<string, unknown> {
  return groupTextEvent('oc_p2p_chat', text, { chatType: 'p2p' });
}

/**
 * Create a bot mention entry.
 * Uses 'cli_' prefix to trigger MentionDetector fallback detection
 * (matches bots whose open_id starts with 'cli_').
 */
function botMention(): { key: string; open_id: string; name: string } {
  return { key: '@_user_1', open_id: 'cli_test_bot_001', name: 'TestBot' };
}

/**
 * Create a non-bot mention entry.
 * Uses 'ou_' prefix (user format) so MentionDetector fallback won't match.
 */
function userMention(): { key: string; open_id: string; name: string } {
  return { key: '@_user_2', open_id: 'ou_other_user_001', name: 'OtherUser' };
}

/** Send a receiveMessage request through IPC and return the result. */
async function sendReceiveMessage(
  client: UnixSocketIpcClient,
  event: Record<string, unknown>,
): Promise<{ success: boolean; emitted: boolean; filterReason?: string }> {
  const result = await client.receiveMessage(event);
  return { success: result.success, emitted: result.emitted, filterReason: result.filterReason };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('IPC message filtering end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let triggerModeManager: TriggerModeManager;
  let emittedMessages: IncomingMessage[];

  /** Create the full message handler stack with real components. */
  function createTestStack(): {
    handler: FeishuMessageHandler;
    triggerModeManager: TriggerModeManager;
  } {
    triggerModeManager = new TriggerModeManager();
    const mentionDetector = new MentionDetector();
    const interactionManager = new InteractionManager();

    emittedMessages = [];

    const handler = new FeishuMessageHandler({
      triggerModeManager,
      mentionDetector,
      interactionManager,
      callbacks: {
        emitMessage: async (msg: IncomingMessage) => {
          emittedMessages.push(msg);
        },
        emitControl: async () => ({ success: false }),
        sendMessage: async () => {},
      },
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    return { handler, triggerModeManager };
  }

  /** Create an IPC server wired to the real MessageHandler. */
  function createServerWithHandler(
    messageHandler: FeishuMessageHandler,
    sockPath: string,
  ): UnixSocketIpcServer {
    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
        receiveMessage: async (event: Record<string, unknown>) => {
          emittedMessages = [];
          await messageHandler.handleMessageReceive(event as FeishuEventData);
          return { emitted: emittedMessages.length > 0 };
        },
      },
    };

    const ipcHandler = createInteractiveMessageHandler(() => {}, container);
    return new UnixSocketIpcServer(ipcHandler, { socketPath: sockPath });
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    const { handler, triggerModeManager: tmm } = createTestStack();
    triggerModeManager = tmm;

    server = createServerWithHandler(handler, socketPath);
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

  // =========================================================================
  // P2P messages — always emitted regardless of trigger mode
  // =========================================================================

  it('should emit P2P message regardless of trigger mode', async () => {
    const result = await sendReceiveMessage(client, p2pTextEvent('Hello in P2P'));

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(true);
  });

  // =========================================================================
  // Group messages in 'mention' mode
  // =========================================================================

  it('should filter group message without @mention in mention mode', async () => {
    triggerModeManager.setMode('oc_group_mention', 'mention');

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_mention', 'Hello without mention'),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(false);
  });

  it('should emit group message with bot @mention in mention mode', async () => {
    triggerModeManager.setMode('oc_group_mention2', 'mention');

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_mention2', '@Bot hello', {
        mentions: [botMention()],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(true);
  });

  it('should filter group message with only user @mention in mention mode', async () => {
    triggerModeManager.setMode('oc_group_mention3', 'mention');

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_mention3', '@User hello', {
        mentions: [userMention()],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(false);
  });

  // =========================================================================
  // Group messages in 'always' mode
  // =========================================================================

  it('should emit group message without @mention in always mode', async () => {
    triggerModeManager.setMode('oc_group_always', 'always');

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_always', 'Hello no mention'),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(true);
  });

  it('should emit group message with @mention in always mode', async () => {
    triggerModeManager.setMode('oc_group_always2', 'always');

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_always2', '@Bot hello', {
        mentions: [botMention()],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(true);
  });

  // =========================================================================
  // Group messages in 'auto' mode
  // =========================================================================

  it('should emit group message in auto mode when marked as small group', async () => {
    triggerModeManager.setMode('oc_group_auto', 'auto');
    triggerModeManager.markAsSmallGroup('oc_group_auto');

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_auto', 'Hello small group'),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(true);
  });

  it('should filter group message in auto mode when not small group', async () => {
    triggerModeManager.setMode('oc_group_auto2', 'auto');
    // Don't mark as small group — should be filtered

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_auto2', 'Hello large group'),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(false);
  });

  it('should emit group message in auto mode with bot @mention even without small group', async () => {
    triggerModeManager.setMode('oc_group_auto3', 'auto');
    // Not marked as small group, but bot is mentioned

    const result = await sendReceiveMessage(
      client,
      groupTextEvent('oc_group_auto3', '@Bot help', {
        mentions: [botMention()],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.emitted).toBe(true);
  });

  // =========================================================================
  // Mode switching
  // =========================================================================

  it('should change behavior when trigger mode switches from mention to always', async () => {
    const chatId = 'oc_group_switch';
    triggerModeManager.setMode(chatId, 'mention');

    // First: filtered (mention mode, no @mention)
    const result1 = await sendReceiveMessage(
      client,
      groupTextEvent(chatId, 'Hello'),
    );
    expect(result1.emitted).toBe(false);

    // Switch to always mode
    triggerModeManager.setMode(chatId, 'always');

    // Second: emitted (always mode, no @mention needed)
    const result2 = await sendReceiveMessage(
      client,
      groupTextEvent(chatId, 'Hello again'),
    );
    expect(result2.emitted).toBe(true);
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  it('should return error when receiveMessage handler is not available', async () => {
    // Create a server WITHOUT the receiveMessage handler
    const errorSocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
        // No receiveMessage handler!
      },
    };

    const emptyIpcHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyIpcHandler, { socketPath: errorSocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: errorSocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

      const result = await sendReceiveMessage(emptyClient, p2pTextEvent('Hello'));

      expect(result.success).toBe(false);
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  // =========================================================================
  // Multiple messages in sequence
  // =========================================================================

  it('should handle multiple messages in sequence correctly', async () => {
    triggerModeManager.setMode('oc_group_seq', 'always');

    const events = [
      groupTextEvent('oc_group_seq', 'First'),
      groupTextEvent('oc_group_seq', 'Second'),
      groupTextEvent('oc_group_seq', 'Third'),
    ];

    for (const event of events) {
      const result = await sendReceiveMessage(client, event);
      expect(result.success).toBe(true);
      expect(result.emitted).toBe(true);
    }
  });
});
