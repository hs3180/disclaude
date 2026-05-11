/**
 * P3 Integration test: Trigger mode message filtering via IPC transport.
 *
 * Tests the full pipeline:
 *   IPC Client  →  Unix Socket  →  IPC Server  →  MessageHandler  →  Filtering decision
 *
 * Verifies that TriggerModeManager and MentionDetector filtering logic works correctly
 * when messages are processed through the real IPC transport layer.
 *
 * Uses real TriggerModeManager, MentionDetector, and MessageHandler instances.
 * No real Feishu credentials needed (no Lark client required for text messages).
 *
 * @see Issue #1626 — P3: passive mode message filtering
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  InteractionManager,
} from '@disclaude/primary-node';
import {
  TriggerModeManager,
  MentionDetector,
  MessageHandler,
} from '../../../packages/primary-node/dist/channels/feishu/index.js';
import type { IpcRequest, IpcResponse, FeishuEventData, IncomingMessage } from '@disclaude/core';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/**
 * Create a mock Feishu event data for text messages.
 */
function createTextEvent(options: {
  chatId: string;
  text: string;
  chatType?: 'p2p' | 'group';
  messageId?: string;
  mentions?: Array<{
    key: string;
    id: { open_id: string; union_id: string; user_id: string };
    name: string;
    tenant_key: string;
  }>;
  senderType?: string;
}): FeishuEventData {
  return {
    event: {
      message: {
        message_id: options.messageId || `om_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        chat_id: options.chatId,
        chat_type: options.chatType || 'group',
        content: JSON.stringify({ text: options.text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions: options.mentions,
      },
      sender: {
        sender_type: options.senderType || 'user',
        sender_id: { open_id: 'ou_test_sender' },
      },
    },
  };
}

/**
 * Create a custom IPC handler that routes messages through a real MessageHandler.
 *
 * The handler receives IPC requests, constructs Feishu events, and passes them
 * through MessageHandler's real filtering pipeline. The response indicates whether
 * the message was processed or filtered by the trigger mode gate.
 */
function createTriggerModeTestHandler(
  triggerModeManager: TriggerModeManager,
  mentionDetector: MentionDetector,
) {
  let lastProcessed = false;

  const messageHandler = new MessageHandler({
    triggerModeManager,
    mentionDetector,
    interactionManager: new InteractionManager(),
    callbacks: {
      emitMessage: async (_message: IncomingMessage) => {
        lastProcessed = true;
      },
      emitControl: async () => ({ success: false, message: '' }),
      sendMessage: async () => {},
    },
    isRunning: () => true,
    hasControlHandler: () => false,
  });

  const handler = async (request: IpcRequest): Promise<IpcResponse> => {
    if (request.type === 'ping') {
      return { id: request.id, success: true, payload: { pong: true } };
    }

    if (request.type === 'sendMessage') {
      const { chatId, text, chat_type, mentions } = request.payload;

      // Reset tracking state before processing
      lastProcessed = false;

      const eventData = createTextEvent({
        chatId,
        text,
        chatType: chat_type || 'group',
        mentions,
      });

      // Process through real MessageHandler pipeline
      await messageHandler.handleMessageReceive(eventData);

      return {
        id: request.id,
        success: true,
        payload: { success: true, processed: lastProcessed },
      };
    }

    return { id: request.id, success: false, error: `Unknown request type: ${request.type}` };
  };

  return { handler };
}

/**
 * Send a test message through IPC with optional chat_type and mentions.
 *
 * Wraps client.request() to pass extra fields needed for trigger mode testing.
 */
async function sendTestMessage(
  client: UnixSocketIpcClient,
  options: {
    chatId: string;
    text: string;
    chatType?: 'p2p' | 'group';
    mentions?: Array<{
      key: string;
      id: { open_id: string; union_id: string; user_id: string };
      name: string;
      tenant_key: string;
    }>;
  },
): Promise<{ success: boolean; processed: boolean }> {
  // Use the public request method; extra fields (chat_type, mentions) are
  // passed through the IPC transport at runtime despite TypeScript's narrower type.
  return client.request(
    'sendMessage',
    // @ts-expect-error — passing test-specific fields (chat_type, mentions) through IPC
    {
      chatId: options.chatId,
      text: options.text,
      chat_type: options.chatType || 'group',
      mentions: options.mentions,
    },
  );
}

describe('Trigger mode message filtering via IPC transport', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let triggerModeManager: TriggerModeManager;
  let mentionDetector: MentionDetector;

  beforeEach(async () => {
    socketPath = generateSocketPath();
    triggerModeManager = new TriggerModeManager();
    mentionDetector = new MentionDetector();

    const { handler } = createTriggerModeTestHandler(triggerModeManager, mentionDetector);

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

  // ---------------------------------------------------------------------------
  // mention mode: only process messages that @mention the bot
  // ---------------------------------------------------------------------------

  describe('mention mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_mention_chat', 'mention');
    });

    it('should filter group message without @mention', async () => {
      const result = await sendTestMessage(client, {
        chatId: 'oc_mention_chat',
        text: 'Hello without mention',
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(false);
    });

    it('should process group message with @mention of the bot', async () => {
      // Use 'cli_' prefix so MentionDetector's fallback pattern detects bot mention
      const mentions = [{
        key: '@_user_1',
        id: { open_id: 'cli_test_bot_id', union_id: 'on_bot', user_id: 'ut_bot' },
        name: 'Bot',
        tenant_key: 'tk_test',
      }];

      const result = await sendTestMessage(client, {
        chatId: 'oc_mention_chat',
        text: '@Bot hello with mention',
        mentions,
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
    });

    it('should not treat regular user @mentions as bot mentions', async () => {
      // Regular user mentions (open_id starts with 'ou_') should NOT trigger bot detection
      const mentions = [{
        key: '@_user_1',
        id: { open_id: 'ou_regular_user', union_id: 'on_user', user_id: 'ut_user' },
        name: 'Alice',
        tenant_key: 'tk_test',
      }];

      const result = await sendTestMessage(client, {
        chatId: 'oc_mention_chat',
        text: '@Alice hello',
        mentions,
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // always mode: process all messages regardless of @mention
  // ---------------------------------------------------------------------------

  describe('always mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_always_chat', 'always');
    });

    it('should process group message without @mention', async () => {
      const result = await sendTestMessage(client, {
        chatId: 'oc_always_chat',
        text: 'Hello without mention',
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
    });

    it('should process group message with @mention', async () => {
      const mentions = [{
        key: '@_user_1',
        id: { open_id: 'cli_test_bot_id', union_id: 'on_bot', user_id: 'ut_bot' },
        name: 'Bot',
        tenant_key: 'tk_test',
      }];

      const result = await sendTestMessage(client, {
        chatId: 'oc_always_chat',
        text: '@Bot hello',
        mentions,
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // auto mode (default): trigger enabled only for small groups
  // ---------------------------------------------------------------------------

  describe('auto mode (default)', () => {
    it('should filter message when not a small group', async () => {
      // Default mode is 'auto', chat not marked as small group
      const result = await sendTestMessage(client, {
        chatId: 'oc_auto_chat',
        text: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(false);
    });

    it('should process message when chat is marked as small group', async () => {
      triggerModeManager.markAsSmallGroup('oc_small_group');

      const result = await sendTestMessage(client, {
        chatId: 'oc_small_group',
        text: 'Hello from small group',
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // p2p (direct message): trigger mode should not apply
  // ---------------------------------------------------------------------------

  describe('p2p chat (direct message)', () => {
    it('should process p2p message regardless of trigger mode setting', async () => {
      // Set to mention mode, but p2p chats should not be filtered
      triggerModeManager.setMode('oc_p2p_chat', 'mention');

      const result = await sendTestMessage(client, {
        chatId: 'oc_p2p_chat',
        text: 'Direct message',
        chatType: 'p2p',
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // dynamic mode switching
  // ---------------------------------------------------------------------------

  describe('dynamic mode switching', () => {
    it('should reflect mode changes immediately through IPC', async () => {
      const chatId = 'oc_dynamic_chat';

      // Start with mention mode — message should be filtered
      triggerModeManager.setMode(chatId, 'mention');
      let result = await sendTestMessage(client, { chatId, text: 'First message' });
      expect(result.processed).toBe(false);

      // Switch to always mode — message should be processed
      triggerModeManager.setMode(chatId, 'always');
      result = await sendTestMessage(client, { chatId, text: 'Second message' });
      expect(result.processed).toBe(true);

      // Switch back to mention mode — filtered again
      triggerModeManager.setMode(chatId, 'mention');
      result = await sendTestMessage(client, { chatId, text: 'Third message' });
      expect(result.processed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // /trigger command always passes through (even in mention mode)
  // ---------------------------------------------------------------------------

  describe('/trigger command passthrough', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_cmd_chat', 'mention');
    });

    it('should process /trigger command even without @mention', async () => {
      const result = await sendTestMessage(client, {
        chatId: 'oc_cmd_chat',
        text: '/trigger',
      });

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
    });
  });
});
