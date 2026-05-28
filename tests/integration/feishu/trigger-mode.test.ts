/**
 * P3 Integration test: MessageHandler trigger mode filtering through IPC pipeline.
 *
 * Tests the full pipeline:
 *   Simulated Feishu Event → MessageHandler (real filtering) → IPC Client → IPC Server → Mock Handler → Capture
 *
 * Verifies that TriggerModeManager and MentionDetector filtering logic works correctly
 * when exercised through the real MessageHandler code paths, with output routed through
 * the real Unix socket IPC transport layer.
 *
 * Uses mock IPC handlers — no real Feishu credentials needed.
 * Runs as part of the standard test suite via `npm run test:feishu`.
 *
 * @see Issue #1626 — P3: 被动模式消息过滤
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  FeishuMessageHandler,
  TriggerModeManager,
  MentionDetector,
  InteractionManager,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import type { FeishuEventData } from '@disclaude/core';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/**
 * Create a simulated Feishu text message event.
 */
function createTextEvent(options: {
  messageId: string;
  chatId: string;
  chatType?: 'p2p' | 'group' | 'topic';
  text: string;
  mentions?: Array<{
    key: string;
    id: { open_id: string; union_id: string; user_id: string };
    name: string;
    tenant_key: string;
  }>;
  senderType?: string;
  senderOpenId?: string;
}): FeishuEventData {
  return {
    event: {
      message: {
        message_id: options.messageId,
        chat_id: options.chatId,
        chat_type: options.chatType ?? 'group',
        content: JSON.stringify({ text: options.text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions: options.mentions,
      },
      sender: {
        sender_type: options.senderType ?? 'user',
        sender_id: {
          open_id: options.senderOpenId ?? 'ou_test_user',
        },
        tenant_key: 'tenant_test',
      },
    },
  };
}

describe('MessageHandler trigger mode filtering via IPC pipeline', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let messageHandler: InstanceType<typeof FeishuMessageHandler>;
  let triggerModeManager: TriggerModeManager;
  let mentionDetector: MentionDetector;

  /** Messages emitted through the MessageHandler (passed filtering) */
  let emittedMessages: Array<{ chatId: string; content: string }>;
  /** Messages captured at IPC server side */
  let ipcCapturedMessages: Array<{ chatId: string; text: string }>;

  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async (chatId, text) => {
          ipcCapturedMessages.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    emittedMessages = [];
    ipcCapturedMessages = [];

    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    // Set up real filtering components
    triggerModeManager = new TriggerModeManager();
    mentionDetector = new MentionDetector();
    // Set bot info directly (no API call needed)
    (mentionDetector as unknown as { botInfo: { open_id: string; app_id: string } }).botInfo = {
      open_id: 'ou_bot_test',
      app_id: 'cli_test_app',
    };

    const interactionManager = new InteractionManager();

    messageHandler = new FeishuMessageHandler({
      triggerModeManager,
      mentionDetector,
      interactionManager,
      callbacks: {
        emitMessage: async (message) => {
          emittedMessages.push({ chatId: message.chatId, content: message.content });
        },
        emitControl: async () => ({ success: false }),
        sendMessage: async (msg) => {
          // Route through IPC transport
          await client.sendMessage(msg.chatId, msg.text ?? '');
        },
      },
      isRunning: () => true,
      hasControlHandler: () => false,
    });
  });

  afterEach(async () => {
    try {
      await client.disconnect();
      await server.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  // --- Mention mode ---

  it('should filter group message without @mention in mention mode', async () => {
    triggerModeManager.setMode('oc_group_mention', 'mention');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_1',
        chatId: 'oc_group_mention',
        text: 'Hello world',
      }),
    );

    expect(emittedMessages).toHaveLength(0);
  });

  it('should process group message with @mention in mention mode', async () => {
    triggerModeManager.setMode('oc_group_mention2', 'mention');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_2',
        chatId: 'oc_group_mention2',
        text: '@_user_1 Hello',
        mentions: [{
          key: '@_user_1',
          id: { open_id: 'ou_bot_test', union_id: 'on_u1', user_id: 'u1' },
          name: 'Bot',
          tenant_key: 't1',
        }],
      }),
    );

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe('oc_group_mention2');
  });

  // --- Always mode ---

  it('should process all group messages in always mode', async () => {
    triggerModeManager.setMode('oc_group_always', 'always');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_3',
        chatId: 'oc_group_always',
        text: 'Hello without mention',
      }),
    );

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe('oc_group_always');
  });

  it('should process group message with @mention in always mode', async () => {
    triggerModeManager.setMode('oc_group_always2', 'always');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_4',
        chatId: 'oc_group_always2',
        text: '@_user_1 Hi',
        mentions: [{
          key: '@_user_1',
          id: { open_id: 'ou_bot_test', union_id: 'on_u1', user_id: 'u1' },
          name: 'Bot',
          tenant_key: 't1',
        }],
      }),
    );

    expect(emittedMessages).toHaveLength(1);
  });

  // --- Auto mode ---

  it('should filter group message in auto mode when not a small group', async () => {
    // 'auto' is the default, no need to set explicitly
    // Group is NOT marked as small group

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_5',
        chatId: 'oc_group_auto_big',
        text: 'Hello',
      }),
    );

    expect(emittedMessages).toHaveLength(0);
  });

  it('should process group message in auto mode when marked as small group', async () => {
    triggerModeManager.markAsSmallGroup('oc_group_auto_small');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_6',
        chatId: 'oc_group_auto_small',
        text: 'Hello',
      }),
    );

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe('oc_group_auto_small');
  });

  // --- P2P chat (always passes through regardless of trigger mode) ---

  it('should always process p2p messages regardless of trigger mode', async () => {
    triggerModeManager.setMode('oc_p2p_chat', 'mention');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_7',
        chatId: 'oc_p2p_chat',
        chatType: 'p2p',
        text: 'Private message',
      }),
    );

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe('oc_p2p_chat');
  });

  // --- /trigger command always passes through trigger mode filtering ---

  it('should pass /trigger command through trigger mode filtering', async () => {
    triggerModeManager.setMode('oc_group_trigger', 'mention');

    // /trigger is explicitly excluded from trigger mode filtering via isTriggerCommand check.
    // Since controlHandler is disabled and there's no default handler for /trigger,
    // it falls through to regular message emission — proving it passed the filter.
    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_8',
        chatId: 'oc_group_trigger',
        text: '/trigger',
      }),
    );

    // Message was NOT filtered — it reached emitMessage (as no command handler caught it)
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].chatId).toBe('oc_group_trigger');
  });

  // --- Bot message filtering ---

  it('should filter bot messages that do not mention our bot', async () => {
    triggerModeManager.setMode('oc_group_bot', 'always');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_9',
        chatId: 'oc_group_bot',
        text: 'Bot message',
        senderType: 'app',
        senderOpenId: 'ou_other_bot',
      }),
    );

    expect(emittedMessages).toHaveLength(0);
  });

  it('should process bot message that mentions our bot (bot-to-bot)', async () => {
    triggerModeManager.setMode('oc_group_bot2', 'always');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_10',
        chatId: 'oc_group_bot2',
        text: '@_user_1 Hello from bot',
        senderType: 'app',
        senderOpenId: 'ou_other_bot',
        mentions: [{
          key: '@_user_1',
          id: { open_id: 'ou_bot_test', union_id: 'on_u1', user_id: 'u1' },
          name: 'Our Bot',
          tenant_key: 't1',
        }],
      }),
    );

    expect(emittedMessages).toHaveLength(1);
  });

  // --- Empty message filtering ---

  it('should filter empty text messages', async () => {
    triggerModeManager.setMode('oc_group_empty', 'always');

    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_11',
        chatId: 'oc_group_empty',
        text: '',  // empty text
      }),
    );

    expect(emittedMessages).toHaveLength(0);
  });

  // --- Duplicate message filtering ---

  it('should filter duplicate messages', async () => {
    triggerModeManager.setMode('oc_group_dup', 'always');

    const event = createTextEvent({
      messageId: 'om_test_dup',
      chatId: 'oc_group_dup',
      text: 'First message',
    });

    await messageHandler.handleMessageReceive(event);
    expect(emittedMessages).toHaveLength(1);

    // Send same message again
    await messageHandler.handleMessageReceive(event);
    expect(emittedMessages).toHaveLength(1); // Still 1 — duplicate filtered
  });

  // --- Full IPC pipeline verification ---

  it('should route command response through IPC transport', async () => {
    triggerModeManager.setMode('oc_group_ipc', 'always');

    // /status command triggers a sendMessage callback which routes through IPC
    await messageHandler.handleMessageReceive(
      createTextEvent({
        messageId: 'om_test_ipc',
        chatId: 'oc_group_ipc',
        text: '/status',
      }),
    );

    // Give IPC a moment to deliver
    await new Promise(resolve => setTimeout(resolve, 200));

    // The /status command should have triggered sendMessage through IPC
    expect(ipcCapturedMessages.length).toBeGreaterThanOrEqual(1);
    expect(ipcCapturedMessages[0].chatId).toBe('oc_group_ipc');
  });
});
