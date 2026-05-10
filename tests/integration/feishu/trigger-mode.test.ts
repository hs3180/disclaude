/**
 * P3 Integration test: Trigger mode message filtering through real MessageHandler.
 *
 * Tests the full pipeline:
 *   Feishu event → MessageHandler → TriggerModeManager → MentionDetector → emitMessage
 *                                        ↕ IPC verification ↕
 *
 * Verifies that trigger mode filtering works correctly when messages flow through
 * the real MessageHandler pipeline integrated with the IPC transport layer.
 *
 * Uses mock IPC handlers and real TriggerModeManager — no real Feishu credentials needed.
 * Runs as part of the Feishu IPC integration test suite.
 *
 * @see Issue #1626 — P3: 被动模式消息过滤
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { TriggerModeManager } from '../../../packages/primary-node/src/channels/feishu/passive-mode.js';
import { MentionDetector } from '../../../packages/primary-node/src/channels/feishu/mention-detector.js';
import { MessageHandler, type MessageCallbacks } from '../../../packages/primary-node/src/channels/feishu/message-handler.js';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/** Counter for unique message/chat IDs to avoid dedup */
let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

/**
 * Build a Feishu event data payload for a text message.
 */
function buildTextEvent(options: {
  chatId: string;
  text: string;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{
    key: string;
    id: { open_id: string; union_id: string; user_id: string };
    name: string;
    tenant_key: string;
  }>;
  senderType?: string;
}): Record<string, unknown> {
  const {
    chatId,
    text,
    chatType = 'group',
    mentions,
    senderType = 'user',
  } = options;

  return {
    event: {
      message: {
        message_id: nextId('om'),
        chat_id: chatId,
        chat_type: chatType,
        content: JSON.stringify({ text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions,
      },
      sender: {
        sender_type: senderType,
        sender_id: { open_id: nextId('ou') },
      },
    },
  };
}

/**
 * Create a bot mention entry that MentionDetector recognizes as a bot mention.
 * Without a client, MentionDetector falls back to heuristic:
 * open_id starting with 'cli_' triggers the bot mention detection.
 */
function botMention(): Array<{
  key: string;
  id: { open_id: string; union_id: string; user_id: string };
  name: string;
  tenant_key: string;
}> {
  return [{
    key: nextId('_user'),
    id: { open_id: 'cli_test_bot_id', union_id: '', user_id: '' },
    name: 'TestBot',
    tenant_key: '',
  }];
}

describe('P3: Trigger mode message filtering via IPC-integrated MessageHandler', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let triggerModeManager: TriggerModeManager;
  let messageHandler: MessageHandler;
  let emittedMessages: Array<{ chatId: string; content: string }>;
  let ipcCapturedMessages: Array<{ chatId: string; text: string }>;
  let mentionDetector: MentionDetector;

  beforeEach(async () => {
    socketPath = generateSocketPath();
    emittedMessages = [];
    ipcCapturedMessages = [];

    triggerModeManager = new TriggerModeManager();
    mentionDetector = new MentionDetector();

    // Set up IPC server + client (same pattern as other integration tests)
    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async (chatId, text) => {
          ipcCapturedMessages.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const ipcHandler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(ipcHandler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    // Wire emitMessage to capture locally AND send through IPC for verification
    const callbacks: MessageCallbacks = {
      emitMessage: async (msg) => {
        emittedMessages.push({ chatId: msg.chatId, content: msg.content as string });
        // Send through IPC transport to verify end-to-end
        await client.sendMessage(msg.chatId, msg.content as string);
      },
      emitControl: async () => ({ success: false }),
      sendMessage: async () => {},
    };

    messageHandler = new MessageHandler({
      triggerModeManager,
      mentionDetector,
      interactionManager: { handleAction: async () => {} } as never,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

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

  // ── mention mode ──────────────────────────────────────────────────

  it('should filter group message without @mention in mention mode', async () => {
    const chatId = nextId('oc_mention_off');
    triggerModeManager.setMode(chatId, 'mention');

    const event = buildTextEvent({ chatId, text: 'hello world' });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(0);
    expect(ipcCapturedMessages).toHaveLength(0);
  });

  it('should process group message with @mention in mention mode', async () => {
    const chatId = nextId('oc_mention_on');
    triggerModeManager.setMode(chatId, 'mention');

    const event = buildTextEvent({
      chatId,
      text: '@_user_1 hello bot',
      mentions: botMention(),
    });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe(chatId);
    expect(ipcCapturedMessages).toHaveLength(1);
    expect(ipcCapturedMessages[0].chatId).toBe(chatId);
  });

  // ── always mode ───────────────────────────────────────────────────

  it('should process group message without @mention in always mode', async () => {
    const chatId = nextId('oc_always');
    triggerModeManager.setMode(chatId, 'always');

    const event = buildTextEvent({ chatId, text: 'no mention needed' });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe(chatId);
    expect(ipcCapturedMessages).toHaveLength(1);
  });

  it('should process group message with @mention in always mode', async () => {
    const chatId = nextId('oc_always_mentioned');
    triggerModeManager.setMode(chatId, 'always');

    const event = buildTextEvent({
      chatId,
      text: '@_user_1 mentioned and always',
      mentions: botMention(),
    });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(1);
    expect(ipcCapturedMessages).toHaveLength(1);
  });

  // ── auto mode (default) ───────────────────────────────────────────

  it('should filter message in auto mode for non-small group', async () => {
    const chatId = nextId('oc_auto_large');
    // Default mode is 'auto', not marked as small group

    const event = buildTextEvent({ chatId, text: 'message in large group' });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(0);
    expect(ipcCapturedMessages).toHaveLength(0);
  });

  it('should process message in auto mode for small group', async () => {
    const chatId = nextId('oc_auto_small');
    // Default mode is 'auto', mark as small group
    triggerModeManager.markAsSmallGroup(chatId);

    const event = buildTextEvent({ chatId, text: 'message in small group' });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe(chatId);
    expect(ipcCapturedMessages).toHaveLength(1);
  });

  // ── p2p chat ──────────────────────────────────────────────────────

  it('should always process p2p message regardless of trigger mode', async () => {
    const chatId = nextId('oc_p2p');
    triggerModeManager.setMode(chatId, 'mention');

    const event = buildTextEvent({
      chatId,
      text: 'p2p message',
      chatType: 'p2p',
    });
    await messageHandler.handleMessageReceive(event as never);

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe(chatId);
  });

  // ── /trigger command passthrough ──────────────────────────────────

  it('should pass /trigger command through even in mention mode', async () => {
    const chatId = nextId('oc_trigger_cmd');
    triggerModeManager.setMode(chatId, 'mention');

    // /trigger command should bypass trigger mode filtering
    const event = buildTextEvent({ chatId, text: '/trigger always' });
    await messageHandler.handleMessageReceive(event as never);

    // /trigger is handled as a control command; the emitMessage may or may not
    // be called depending on controlHandler availability. The key assertion is
    // that the message is NOT filtered by trigger_mode (it reaches command handling).
    // Since hasControlHandler returns false and /trigger is not in the fallback
    // commands (reset/status/stop), it falls through to emitMessage.
    expect(emittedMessages).toHaveLength(1);
  });

  // ── mode transition ───────────────────────────────────────────────

  it('should respect mode changes within the same chat', async () => {
    const chatId = nextId('oc_transition');

    // Start with mention mode — message should be filtered
    triggerModeManager.setMode(chatId, 'mention');
    let event = buildTextEvent({ chatId, text: 'filtered message' });
    await messageHandler.handleMessageReceive(event as never);
    expect(emittedMessages).toHaveLength(0);

    // Switch to always mode — message should be processed
    triggerModeManager.setMode(chatId, 'always');
    event = buildTextEvent({ chatId, text: 'processed message' });
    await messageHandler.handleMessageReceive(event as never);
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].content).toContain('processed message');

    // Switch back to mention mode — message should be filtered again
    triggerModeManager.setMode(chatId, 'mention');
    event = buildTextEvent({ chatId, text: 'filtered again' });
    await messageHandler.handleMessageReceive(event as never);
    expect(emittedMessages).toHaveLength(1); // still 1, no new message
  });

  // ── IPC transport verification ────────────────────────────────────

  it('should verify filtering outcome through IPC transport', async () => {
    const chatId = nextId('oc_ipc_verify');
    triggerModeManager.setMode(chatId, 'always');

    const event = buildTextEvent({ chatId, text: 'ipc transport test' });
    await messageHandler.handleMessageReceive(event as never);

    // Verify the message went through the full IPC chain:
    // emitMessage → IPC client → Unix socket → IPC server → mock handler
    expect(emittedMessages).toHaveLength(1);
    expect(ipcCapturedMessages).toHaveLength(1);
    expect(ipcCapturedMessages[0].chatId).toBe(chatId);
    expect(ipcCapturedMessages[0].text).toBe('ipc transport test');
  });
});
