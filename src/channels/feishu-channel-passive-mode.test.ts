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
  Client: vi.fn(() => ({
    request: vi.fn().mockResolvedValue({
      data: {
        bot: {
          open_id: 'cli_test_bot_id',
          app_name: 'Test Bot',
        },
      },
    }),
  })),
  WSClient: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
  EventDispatcher: vi.fn(() => ({
    register: vi.fn().mockReturnThis(),
  })),
  LoggerLevel: { info: 'info' },
  Domain: { Feishu: 'https://open.feishu.cn' },
}));

// Issue #1033: Mock LarkClientService
vi.mock('../services/index.js', () => ({
  getLarkClientService: vi.fn(() => ({
    getClient: vi.fn(() => ({
      request: vi.fn().mockResolvedValue({
        data: {
          bot: {
            open_id: 'cli_test_bot_id',
            app_name: 'Test Bot',
          },
        },
      }),
    })),
  })),
  isLarkClientServiceInitialized: vi.fn(() => true),
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
    getDebugConfig: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../config/constants.js', () => ({
  DEDUPLICATION: { MAX_MESSAGE_AGE: 300000 },
  REACTIONS: { TYPING: 'Typing' },
  FEISHU_API: { REQUEST_TIMEOUT_MS: 30000 },
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
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id from mock
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

    it('should NOT handle control commands in group chat without @mention (Issue #650)', async () => {
      await simulateMessageReceive({
        text: '/status',
        chatId: 'oc_test_group', // Group chat ID
        mentions: undefined, // No mentions
      });

      // Issue #650: Control commands should NOT be handled without @mention in group chats
      // Control handler should NOT be called
      expect(controlHandler).not.toHaveBeenCalled();

      // Message should NOT be passed to agent
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should NOT handle /reset in group chat without @mention (Issue #650)', async () => {
      await simulateMessageReceive({
        text: '/reset',
        chatId: 'oc_test_group',
        mentions: undefined,
      });

      // Issue #650: Control commands should NOT be handled without @mention in group chats
      expect(controlHandler).not.toHaveBeenCalled();
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should skip any command in group chat without @mention (Issue #650)', async () => {
      await simulateMessageReceive({
        text: '/custom-command',
        chatId: 'oc_test_group',
        mentions: undefined,
      });

      // Issue #650: ALL commands should be skipped without @mention in group chats
      // Control handler should NOT be called
      expect(controlHandler).not.toHaveBeenCalled();

      // Message should NOT be passed to agent (passive mode)
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should show error for unknown command in group chat WITH @mention (Issue #595)', async () => {
      await simulateMessageReceive({
        text: '/custom-command',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id
            name: 'Bot',
          },
        ],
      });

      // Control handler should NOT be called (unknown command)
      expect(controlHandler).not.toHaveBeenCalled();

      // Message should NOT be passed to agent (Issue #595 fix)
      // Instead, an error message is shown to the user
      expect(messageHandler).not.toHaveBeenCalled();
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
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id from mock
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
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id from mock
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

    it('should NOT respond when only other user is mentioned (Issue #600)', async () => {
      await simulateMessageReceive({
        text: '@user1 can you help?',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_user1',
            id: { open_id: 'user1-open-id' }, // Another user, not bot
            name: 'User1',
          },
        ],
      });

      // Should NOT process (bot is NOT mentioned)
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should respond when bot is mentioned with correct open_id (Issue #600)', async () => {
      await simulateMessageReceive({
        text: '@bot please help',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id from mock
            name: 'Bot',
          },
        ],
      });

      // Should process (bot IS mentioned with correct open_id)
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@bot please help',
        })
      );
    });

    it('should respond to bot mention with exact open_id match', async () => {
      // When bot's open_id is fetched, only exact matches should trigger response
      await simulateMessageReceive({
        text: '@bot help',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'cli_test_bot_id' }, // Exact match with mock botOpenId
            name: 'Bot',
          },
        ],
      });

      // Should process (exact open_id match)
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@bot help',
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
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id from mock
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

  /**
   * Issue #511: Passive mode control for group chats
   */
  describe('Passive mode control (Issue #511)', () => {
    it('should process group chat message when passive mode is disabled', async () => {
      // Disable passive mode for this chat
      channel.setPassiveModeDisabled('oc_test_group', true);

      await simulateMessageReceive({
        text: 'Hello everyone!',
        chatId: 'oc_test_group',
        mentions: undefined, // No mentions
      });

      // Message SHOULD be passed to agent (passive mode disabled)
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello everyone!',
        })
      );
    });

    it('should skip group chat message when passive mode is re-enabled', async () => {
      // First disable, then re-enable passive mode
      channel.setPassiveModeDisabled('oc_test_group', true);
      channel.setPassiveModeDisabled('oc_test_group', false);

      await simulateMessageReceive({
        text: 'Hello everyone!',
        chatId: 'oc_test_group',
        mentions: undefined,
      });

      // Message should NOT be passed to agent (passive mode re-enabled)
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should track passive mode state per chat', async () => {
      // Disable passive mode for one chat
      channel.setPassiveModeDisabled('oc_group_1', true);

      // Simulate message in group 1 (passive mode disabled)
      await simulateMessageReceive({
        text: 'Hello group 1',
        chatId: 'oc_group_1',
        mentions: undefined,
      });

      // Should be processed
      expect(messageHandler).toHaveBeenCalledTimes(1);

      // Simulate message in group 2 (passive mode enabled by default)
      await simulateMessageReceive({
        text: 'Hello group 2',
        chatId: 'oc_group_2',
        mentions: undefined,
      });

      // Should NOT be processed (passive mode still enabled for group 2)
      expect(messageHandler).toHaveBeenCalledTimes(1); // Still 1, not incremented
    });

    it('should correctly report passive mode status', () => {
      // Initially passive mode is enabled (not disabled)
      expect(channel.isPassiveModeDisabled('oc_test_group')).toBe(false);

      // After disabling
      channel.setPassiveModeDisabled('oc_test_group', true);
      expect(channel.isPassiveModeDisabled('oc_test_group')).toBe(true);

      // After re-enabling
      channel.setPassiveModeDisabled('oc_test_group', false);
      expect(channel.isPassiveModeDisabled('oc_test_group')).toBe(false);
    });

    it('should return list of chats with passive mode disabled', () => {
      // Initially empty
      expect(channel.getPassiveModeDisabledChats()).toEqual([]);

      // Add some chats
      channel.setPassiveModeDisabled('oc_group_1', true);
      channel.setPassiveModeDisabled('oc_group_2', true);

      expect(channel.getPassiveModeDisabledChats()).toContain('oc_group_1');
      expect(channel.getPassiveModeDisabledChats()).toContain('oc_group_2');

      // Remove one
      channel.setPassiveModeDisabled('oc_group_1', false);
      expect(channel.getPassiveModeDisabledChats()).not.toContain('oc_group_1');
      expect(channel.getPassiveModeDisabledChats()).toContain('oc_group_2');
    });

    it('should still process @mentioned messages when passive mode is disabled', async () => {
      channel.setPassiveModeDisabled('oc_test_group', true);

      await simulateMessageReceive({
        text: '@bot Hello!',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'cli_test_bot_id' }, // Bot's open_id from mock
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
  });
});
