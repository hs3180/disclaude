/**
 * Tests for FeishuChannel command handling behavior when bot is mentioned.
 *
 * Issue #387: /reset 命令在 @提及 时不生效
 *
 * Control commands (reset, status, help, restart, list-nodes, switch-node) should
 * ALWAYS be handled locally through the control channel, regardless of @mentions.
 * This ensures session/agent lifecycle commands work correctly.
 *
 * Non-control commands with @mention should be passed to the agent.
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
  Domain: { Feishu: 'https://open.feishu.cn' },
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

vi.mock('../nodes/commands/command-registry.js', () => ({
  getCommandRegistry: vi.fn(() => ({
    has: (name: string) => ['reset', 'status', 'help', 'restart', 'list-nodes', 'switch-node',
      'create-group', 'add-group-member', 'remove-group-member', 'list-group-members', 'list-group', 'dissolve-group'].includes(name),
    getAll: () => [],
    register: vi.fn(),
  })),
  resetCommandRegistry: vi.fn(),
}));

import { FeishuChannel } from './feishu-channel.js';

describe('FeishuChannel - Control Command Handling (Issue #387)', () => {
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

  describe('Control commands should ALWAYS be handled locally (Issue #387)', () => {
    it('should handle /reset locally when bot is NOT mentioned', async () => {
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

    it('should handle /reset locally even when bot IS mentioned (Issue #387 fix)', async () => {
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

      // Control handler SHOULD be called - control commands always handled locally
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          chatId: 'test-chat-id',
        })
      );

      // Message should NOT be passed to agent
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /reset locally when there are multiple mentions', async () => {
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

      // Control command should be handled locally
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          chatId: 'test-chat-id',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /status locally when bot is mentioned', async () => {
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

      // Control handler should be called
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should handle /help locally when bot is mentioned', async () => {
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

      // Control handler should be called
      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'help',
        })
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('Unknown commands with @mention should show error (Issue #595)', () => {
    it('should show error for unknown commands when bot is mentioned', async () => {
      await simulateMessageReceive({
        text: '/unknown-command',
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

      // Message should NOT be passed to agent (Issue #595 fix)
      // Instead, an error message is sent to the user
      expect(messageHandler).not.toHaveBeenCalled();
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
  });

  describe('Commands without mentions', () => {
    it('should handle /status without mentions', async () => {
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
