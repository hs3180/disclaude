/**
 * Tests for FeishuChannel control command handling when bot is mentioned.
 *
 * Issue #387: /reset 命令在 @提及 时不生效
 *
 * Control commands (reset, restart, status, list-nodes, switch-node) should
 * ALWAYS be handled by the control handler, regardless of whether the bot is mentioned.
 * Non-control commands when bot is mentioned will be passed to the agent.
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
    addReaction: vi.fn().mockResolvedValue(undefined),
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

describe('FeishuChannel - Control Commands (Issue #387)', () => {
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
   */
  async function simulateMessageReceive(options: {
    text: string;
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  }): Promise<void> {
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

    const handler = (channel as unknown as { handleMessageReceive: (data: unknown) => Promise<void> }).handleMessageReceive.bind(channel);
    await channel.start();
    await handler({ event: mockEvent });
  }

  describe('Control commands should ALWAYS be handled by control handler', () => {
    it('should handle /reset when bot is NOT mentioned', async () => {
      await simulateMessageReceive({
        text: '/reset',
        mentions: undefined,
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          chatId: 'test-chat-id',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /reset when bot IS mentioned (Issue #387)', async () => {
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

      // Control handler SHOULD be called even when bot is mentioned
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          chatId: 'test-chat-id',
        })
      );
      // Message should NOT be passed to agent
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /status when bot IS mentioned', async () => {
      await simulateMessageReceive({
        text: '/status',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /restart when bot IS mentioned', async () => {
      await simulateMessageReceive({
        text: '/restart',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'restart',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /list-nodes when bot IS mentioned', async () => {
      await simulateMessageReceive({
        text: '/list-nodes',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'list-nodes',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /switch-node when bot IS mentioned', async () => {
      await simulateMessageReceive({
        text: '/switch-node node-123',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'switch-node',
          data: expect.objectContaining({
            args: ['node-123'],
          }),
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('Non-control commands should be passed to agent when bot is mentioned', () => {
    it('should pass unknown commands to agent when bot IS mentioned', async () => {
      await simulateMessageReceive({
        text: '/custom-command',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Control handler should NOT be called for unknown commands
      expect(controlHandler).not.toHaveBeenCalled();
      // Message should be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'test-chat-id',
          content: '/custom-command',
        })
      );
    });

    it('should pass /help to agent when bot IS mentioned (help is not a control command)', async () => {
      await simulateMessageReceive({
        text: '/help',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // /help is not a control command, should be passed to agent
      expect(controlHandler).not.toHaveBeenCalled();
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '/help',
        })
      );
    });
  });

  describe('Regular messages should be passed to agent', () => {
    it('should pass regular messages to agent when bot is mentioned', async () => {
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

      expect(controlHandler).not.toHaveBeenCalled();
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello bot!',
        })
      );
    });

    it('should pass regular messages to agent without mentions', async () => {
      await simulateMessageReceive({
        text: 'Hello!',
        mentions: undefined,
      });

      expect(controlHandler).not.toHaveBeenCalled();
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello!',
        })
      );
    });
  });

  describe('Multiple mentions behavior', () => {
    it('should still handle control commands with multiple mentions', async () => {
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

      // Control command should still be handled
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('Fallback behavior when control handler fails', () => {
    it('should pass command to agent if control handler returns failure', async () => {
      controlHandler.mockResolvedValue({
        success: false,
        error: 'Unknown command',
      });

      await simulateMessageReceive({
        text: '/reset',
        mentions: [
          {
            key: '@_bot',
            id: { open_id: 'bot-open-id' },
            name: 'Bot',
          },
        ],
      });

      // Control handler was called
      expect(controlHandler).toHaveBeenCalled();
      // But since it failed, message should be passed to agent
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '/reset',
        })
      );
    });
  });
});
