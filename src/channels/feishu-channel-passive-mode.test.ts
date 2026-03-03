/**
 * Tests for FeishuChannel group chat passive mode.
 *
 * Issue #460: 群聊被动模式 - 被 @ 时才回应
 *
 * In group chats, the bot should only respond when mentioned (@bot).
 * This allows scheduled tasks to broadcast without triggering unwanted responses.
 *
 * Behavior:
 * - Group chat (oc_*): Only respond when @mentioned
 * - Private chat (ou_* or other): Always respond
 * - Control commands: Always handled regardless of @mention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => ({})),
  WSClient: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
  EventDispatcher: vi.fn(() => ({
    register: vi.fn().mockReturnThis(),
  })),
  LoggerLevel: { info: 'info' },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
  },
}));

vi.mock('../config/constants.js', () => ({
  DEDUPLICATION: { MAX_MESSAGE_AGE: 300000 },
  REACTIONS: { TYPING: 'Typing' },
}));

vi.mock('../feishu/message-logger.js', () => ({
  messageLogger: {
    init: vi.fn().mockResolvedValue(undefined),
    isMessageProcessed: vi.fn().mockReturnValue(false),
    logIncomingMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../file-transfer/inbound/index.js', () => ({
  attachmentManager: {
    getAttachments: vi.fn().mockReturnValue([]),
    cleanupOldAttachments: vi.fn(),
  },
  downloadFile: vi.fn(),
}));

vi.mock('../platforms/feishu/feishu-file-handler.js', () => ({
  FeishuFileHandler: vi.fn(() => ({
    handleFileMessage: vi.fn().mockResolvedValue({ success: false }),
    buildUploadPrompt: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('../platforms/feishu/feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn(() => ({
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn(() => ({
    handleAction: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../feishu/task-flow-orchestrator.js', () => ({
  TaskFlowOrchestrator: vi.fn(),
}));

vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn(),
}));

import { FeishuChannel } from './feishu-channel.js';

describe('FeishuChannel - Group Chat Passive Mode (Issue #460)', () => {
  let channel: FeishuChannel;
  let messageHandler: ReturnType<typeof vi.fn>;
  let controlHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    channel = new FeishuChannel({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });

    messageHandler = vi.fn().mockResolvedValue(undefined);
    controlHandler = vi.fn().mockResolvedValue({
      success: true,
      message: 'Command handled',
    });

    channel.onMessage(messageHandler);
    channel.onControl(controlHandler);
  });

  afterEach(async () => {
    try {
      await channel.stop();
    } catch {
      // Ignore errors during cleanup
    }
  });

  /**
   * Helper to simulate receiving a message.
   * We access the private method via type casting for testing.
   */
  async function simulateMessageReceive(options: {
    text: string;
    chatId?: string;
    chatType?: string;
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  }): Promise<void> {
    // Determine chat_type based on chatId prefix if not explicitly provided
    let { chatType } = options;
    if (!chatType) {
      const chatId = options.chatId || 'oc_test_group';
      if (chatId.startsWith('oc_')) {
        chatType = 'group';
      } else if (chatId.startsWith('ou_')) {
        chatType = 'p2p';
      } else {
        chatType = 'p2p'; // Default to p2p for unknown formats
      }
    }

    // Create a mock event that matches FeishuEventData structure
    const mockEvent = {
      message: {
        message_id: 'test-msg-id',
        chat_id: options.chatId || 'oc_test_group', // Default to group chat
        chat_type: chatType,
        content: JSON.stringify({ text: options.text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions: options.mentions,
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user_open_id' },
      },
    };

    // Access private method for testing
    const handler = (channel as unknown as { handleMessageReceive: (data: unknown) => Promise<void> }).handleMessageReceive.bind(channel);

    // Start the channel first to set isRunning = true
    await channel.start();

    await handler({ event: mockEvent });
  }

  describe('Group chat passive mode', () => {
    it('should skip group chat message without @mention (passive mode)', async () => {
      await simulateMessageReceive({
        text: 'Hello everyone!',
        chatId: 'oc_test_group', // Group chat ID
        mentions: undefined, // No mentions
      });

      // Message should NOT be passed to agent (skipped due to passive mode)
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should process group chat message WITH @mention', async () => {
      await simulateMessageReceive({
        text: '@bot Hello!',
        chatId: 'oc_test_group', // Group chat ID
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Message SHOULD be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@bot Hello!',
        })
      );
    });

    it('should always handle control commands in group chat even without @mention', async () => {
      await simulateMessageReceive({
        text: '/status',
        chatId: 'oc_test_group', // Group chat ID
        mentions: undefined, // No mentions
      });

      // Control handler SHOULD be called - control commands always handled
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          chatId: 'oc_test_group',
        })
      );

      // Message should NOT be passed to agent
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /reset in group chat without @mention', async () => {
      await simulateMessageReceive({
        text: '/reset',
        chatId: 'oc_test_group',
        mentions: undefined,
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should skip non-control command in group chat without @mention', async () => {
      await simulateMessageReceive({
        text: '/custom-command',
        chatId: 'oc_test_group',
        mentions: undefined,
      });

      // Control handler returns success: false for unknown commands
      // But passive mode should still skip the message
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'custom-command',
        })
      );

      // Message should NOT be passed to agent (passive mode)
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should process non-control command in group chat WITH @mention', async () => {
      await simulateMessageReceive({
        text: '/custom-command',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Control handler should NOT be called (unknown command with @mention goes to agent)
      expect(controlHandler).not.toHaveBeenCalled();

      // Message SHOULD be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '/custom-command',
        })
      );
    });
  });

  describe('Private chat - no passive mode', () => {
    it('should process private chat message without @mention', async () => {
      await simulateMessageReceive({
        text: 'Hello!',
        chatId: 'ou_user_private', // Private chat ID (user open_id)
        mentions: undefined,
      });

      // Message SHOULD be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello!',
        })
      );
    });

    it('should process private chat message with @mention', async () => {
      await simulateMessageReceive({
        text: '@bot Hello!',
        chatId: 'ou_user_private',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Message SHOULD be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@bot Hello!',
        })
      );
    });

    it('should handle control commands in private chat', async () => {
      await simulateMessageReceive({
        text: '/reset',
        chatId: 'ou_user_private',
        mentions: undefined,
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle group chat ID with oc_ prefix', async () => {
      await simulateMessageReceive({
        text: 'Test message',
        chatId: 'oc_another_group',
        mentions: undefined,
      });

      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle non-standard chat ID (fallback to processing)', async () => {
      // Non-standard chat ID (not oc_ or ou_) should be processed
      await simulateMessageReceive({
        text: 'Test message',
        chatId: 'unknown_chat_format',
        mentions: undefined,
      });

      // Should process the message (not a group chat)
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Test message',
        })
      );
    });

    it('should handle empty mentions array', async () => {
      await simulateMessageReceive({
        text: 'Hello!',
        chatId: 'oc_test_group',
        mentions: [], // Empty mentions array
      });

      // Should skip (no bot mention)
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle multiple mentions including bot', async () => {
      await simulateMessageReceive({
        text: '@user1 @bot help me',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_user1',
            id: { open_id: 'user1-open-id' },
            name: 'User1',
          },
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Should process (bot is mentioned)
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@user1 @bot help me',
        })
      );
    });
  });

  describe('Reaction behavior (Issue #514)', () => {
    it('should NOT add reaction to group chat message without @mention (passive mode)', async () => {
      await simulateMessageReceive({
        text: 'Hello everyone!',
        chatId: 'oc_test_group', // Group chat ID
        mentions: undefined, // No mentions
      });

      // Get the FeishuMessageSender mock instance
      const { FeishuMessageSender } = await import('../platforms/feishu/feishu-message-sender.js');
      const senderInstance = (FeishuMessageSender as ReturnType<typeof vi.fn>).mock.results[0]?.value;

      // Reaction should NOT be added for skipped messages
      expect(senderInstance?.addReaction).not.toHaveBeenCalled();
    });

    it('should add reaction to group chat message WITH @mention', async () => {
      await simulateMessageReceive({
        text: '@bot Hello!',
        chatId: 'oc_test_group', // Group chat ID
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Get the FeishuMessageSender mock instance
      const { FeishuMessageSender } = await import('../platforms/feishu/feishu-message-sender.js');
      const senderInstance = (FeishuMessageSender as ReturnType<typeof vi.fn>).mock.results[0]?.value;

      // Reaction SHOULD be added for messages that are processed
      expect(senderInstance?.addReaction).toHaveBeenCalledWith('test-msg-id', 'Typing');
    });

    it('should add reaction to private chat message', async () => {
      await simulateMessageReceive({
        text: 'Hello!',
        chatId: 'ou_user_private', // Private chat ID
        mentions: undefined,
      });

      // Get the FeishuMessageSender mock instance
      const { FeishuMessageSender } = await import('../platforms/feishu/feishu-message-sender.js');
      const senderInstance = (FeishuMessageSender as ReturnType<typeof vi.fn>).mock.results[0]?.value;

      // Reaction SHOULD be added for private chat messages
      expect(senderInstance?.addReaction).toHaveBeenCalledWith('test-msg-id', 'Typing');
    });
  });
});
