/**
 * Tests for FeishuChannel bot mention detection.
 *
 * Issue #681: 群聊被动模式 @机器人检测不可靠问题
 *
 * This test verifies that the bot mention detection correctly matches both
 * bot's open_id and app_id when mentioned in group chats.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => ({
    request: vi.fn().mockResolvedValue({
      data: {
        bot: {
          open_id: 'ou_bot_open_id',
          app_id: 'cli_test_app_id',
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
            open_id: 'ou_bot_open_id',
            app_id: 'cli_test_app_id',
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

describe('FeishuChannel - Bot Mention Detection (Issue #681)', () => {
  let channel: FeishuChannel;
  let messageHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    channel = new FeishuChannel({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });

    messageHandler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(messageHandler);
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
   */
  async function simulateMessageReceive(options: {
    text: string;
    chatId?: string;
    chatType?: string;
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  }): Promise<void> {
    let { chatType } = options;
    if (!chatType) {
      const chatId = options.chatId || 'oc_test_group';
      if (chatId.startsWith('oc_')) {
        chatType = 'group';
      } else if (chatId.startsWith('ou_')) {
        chatType = 'p2p';
      } else {
        chatType = 'p2p';
      }
    }

    const mockEvent = {
      message: {
        message_id: 'test-msg-id',
        chat_id: options.chatId || 'oc_test_group',
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

    const handler = (channel as unknown as { handleMessageReceive: (data: unknown) => Promise<void> }).handleMessageReceive.bind(channel);
    await channel.start();
    await handler({ event: mockEvent });
  }

  describe('Bot mention with open_id matching bot.open_id', () => {
    it('should detect bot mention when mention.open_id matches bot.open_id', async () => {
      await simulateMessageReceive({
        text: '@bot help',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'ou_bot_open_id' }, // Matches bot.open_id from mock
            name: 'Bot',
          },
        ],
      });

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@bot help',
        })
      );
    });
  });

  describe('Bot mention with open_id matching bot.app_id', () => {
    it('should detect bot mention when mention.open_id matches bot.app_id', async () => {
      // Feishu may use app_id instead of open_id when bot is mentioned
      await simulateMessageReceive({
        text: '@bot help',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'cli_test_app_id' }, // Matches bot.app_id from mock
            name: 'Bot',
          },
        ],
      });

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '@bot help',
        })
      );
    });
  });

  describe('Bot not mentioned', () => {
    it('should NOT respond when mention.open_id does not match bot info', async () => {
      await simulateMessageReceive({
        text: '@user1 help',
        chatId: 'oc_test_group',
        mentions: [
          {
            key: '@_user1',
            id: { open_id: 'ou_other_user_id' }, // Does not match bot.open_id or bot.app_id
            name: 'User1',
          },
        ],
      });

      expect(messageHandler).not.toHaveBeenCalled();
    });
  });
});
