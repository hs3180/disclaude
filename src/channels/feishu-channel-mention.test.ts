/**
 * Tests for FeishuChannel command pass-through behavior when bot is mentioned.
 *
 * Issue #280: @bot 无法正确透传 /reset 指令给 agent
 *
 * When bot is mentioned (@bot), commands should be passed through to the agent
 * instead of being handled locally by the channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(function () {}),
  WSClient: vi.fn(function () {
    this.start = vi.fn().mockResolvedValue(undefined);
  }),
  EventDispatcher: vi.fn(function () {
    this.register = vi.fn().mockReturnThis();
  }),
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
  FeishuFileHandler: vi.fn(function () {
    this.handleFileMessage = vi.fn().mockResolvedValue({ success: false });
    this.buildUploadPrompt = vi.fn().mockReturnValue('');
  }),
}));

vi.mock('../platforms/feishu/feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn(function () {
    this.sendText = vi.fn().mockResolvedValue(undefined);
    this.sendCard = vi.fn().mockResolvedValue(undefined);
    this.sendFile = vi.fn().mockResolvedValue(undefined);
    this.addReaction = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn(function () {
    this.handleAction = vi.fn();
    this.dispose = vi.fn();
  }),
}));

vi.mock('../feishu/task-flow-orchestrator.js', () => ({
  TaskFlowOrchestrator: vi.fn(),
}));

vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn(),
}));

import { FeishuChannel } from './feishu-channel.js';
import type { IncomingMessage } from './types.js';

describe('FeishuChannel - Command Pass-through (Issue #280)', () => {
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

  describe('isBotMentioned helper (indirectly tested via command behavior)', () => {
    /**
     * Helper to simulate receiving a message.
     * We access the private method via type casting for testing.
     */
    async function simulateMessageReceive(options: {
      text: string;
      mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
    }): Promise<void> {
      // Create a mock event that matches FeishuEventData structure
      const mockEvent = {
        message: {
          message_id: 'test-msg-id',
          chat_id: 'test-chat-id',
          content: JSON.stringify({ text: options.text }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: options.mentions,
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'user-open-id' },
        },
      };

      // Access private method for testing
      const handler = (channel as unknown as { handleMessageReceive: (data: unknown) => Promise<void> }).handleMessageReceive.bind(channel);

      // Start the channel first to set isRunning = true
      await channel.start();

      await handler({ event: mockEvent });
    }

    it('should handle command locally when bot is NOT mentioned', async () => {
      await simulateMessageReceive({
        text: '/reset',
        mentions: undefined, // No mentions
      });

      // Control handler should be called (local handling)
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          chatId: 'test-chat-id',
        })
      );

      // Message should NOT be passed to agent
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should pass command to agent when bot IS mentioned', async () => {
      await simulateMessageReceive({
        text: '/reset',
        mentions: [
          {
            key: '@_user',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Control handler should NOT be called (command passed to agent)
      expect(controlHandler).not.toHaveBeenCalled();

      // Message should be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'test-chat-id',
          content: '/reset',
        })
      );
    });

    it('should pass command to agent when there are multiple mentions', async () => {
      await simulateMessageReceive({
        text: '/reset',
        mentions: [
          {
            key: '@_user1',
            id: { open_id: 'user1-open-id' },
            name: 'User1',
          },
          {
            key: '@_user2',
            id: { open_id: 'user2-open-id' },
            name: 'User2',
          },
        ],
      });

      // Command should be passed to agent
      expect(controlHandler).not.toHaveBeenCalled();
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '/reset',
        })
      );
    });

    it('should handle regular messages normally (without / prefix)', async () => {
      await simulateMessageReceive({
        text: 'Hello bot!',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // No control handler call
      expect(controlHandler).not.toHaveBeenCalled();

      // Message passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello bot!',
        })
      );
    });

    it('should handle command without mentions normally', async () => {
      await simulateMessageReceive({
        text: '/status',
        mentions: undefined,
      });

      // Control handler should be called
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
        })
      );
    });
  });
});
