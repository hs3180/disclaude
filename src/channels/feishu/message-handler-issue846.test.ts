/**
 * Tests for Issue #846: Support reading packed conversation records and quoted replies.
 *
 * This test file covers:
 * 1. Parsing chat_record message type (forwarded conversations)
 * 2. Extracting reply context from root_id and parent_id fields
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => ({})),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../config/constants.js', () => ({
  DEDUPLICATION: { MAX_MESSAGE_AGE: 300000 },
  REACTIONS: { TYPING: 'Typing' },
  CHAT_HISTORY: { MAX_CONTEXT_LENGTH: 5000 },
}));

vi.mock('../../feishu/message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: vi.fn().mockReturnValue(false),
    logIncomingMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../file-transfer/inbound/index.js', () => ({
  attachmentManager: {
    getAttachments: vi.fn().mockReturnValue([]),
  },
  downloadFile: vi.fn(),
}));

vi.mock('../../platforms/feishu/feishu-file-handler.js', () => ({
  FeishuFileHandler: vi.fn(() => ({
    handleFileMessage: vi.fn().mockResolvedValue({ success: false }),
    buildUploadPrompt: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('../../platforms/feishu/feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn(() => ({
    sendText: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('../../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn(() => ({
    handleAction: vi.fn(),
  })),
}));

vi.mock('../../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../../nodes/commands/command-registry.js', () => ({
  getCommandRegistry: vi.fn(() => ({
    has: vi.fn().mockReturnValue(false),
  })),
}));

vi.mock('../../mcp/feishu-context-mcp.js', () => ({
  resolvePendingInteraction: vi.fn().mockReturnValue(false),
}));

vi.mock('../../mcp/tools/interactive-message.js', () => ({
  generateInteractionPrompt: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../ipc/unix-socket-client.js', () => ({
  getIpcClient: vi.fn().mockReturnValue({
    isConnected: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('../../feishu/filtered-message-forwarder.js', () => ({
  filteredMessageForwarder: {
    setMessageSender: vi.fn(),
    forward: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils/mention-parser.js', () => ({
  stripLeadingMentions: vi.fn().mockReturnValue(''),
}));

import { MessageHandler } from './message-handler.js';

describe('MessageHandler - Issue #846', () => {
  let handler: MessageHandler;
  let mockCallbacks: {
    emitMessage: ReturnType<typeof vi.fn>;
    emitControl: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    routeCardAction: ReturnType<typeof vi.fn>;
  };
  let mockPassiveModeManager: { isPassiveModeDisabled: ReturnType<typeof vi.fn> };
  let mockMentionDetector: { isBotMentioned: ReturnType<typeof vi.fn> };
  let mockInteractionManager: { handleAction: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallbacks = {
      emitMessage: vi.fn().mockResolvedValue(undefined),
      emitControl: vi.fn().mockResolvedValue({ success: false }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      routeCardAction: vi.fn().mockResolvedValue(false),
    };

    mockPassiveModeManager = {
      isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    };

    mockMentionDetector = {
      isBotMentioned: vi.fn().mockReturnValue(true), // Bot is mentioned by default
    };

    mockInteractionManager = {
      handleAction: vi.fn().mockResolvedValue(false),
    };

    handler = new MessageHandler({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      passiveModeManager: mockPassiveModeManager as unknown as import('./passive-mode.js').PassiveModeManager,
      mentionDetector: mockMentionDetector as unknown as import('./mention-detector.js').MentionDetector,
      interactionManager: mockInteractionManager as unknown as import('../../platforms/feishu/interaction-manager.js').InteractionManager,
      callbacks: mockCallbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    handler.initialize();
  });

  describe('chat_record message type (packed conversation)', () => {
    it('should parse chat_record message with multiple forwarded messages', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello from user A' }),
            create_time: 1700000000000,
            sender: { sender_id: { open_id: 'user_a' } },
          },
          {
            message_id: 'msg_2',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello from user B' }),
            create_time: 1700000001000,
            sender: { sender_id: { open_id: 'user_b' } },
          },
        ],
      };

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'chat_record',
            content: JSON.stringify(chatRecordContent),
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      expect(mockCallbacks.emitMessage).toHaveBeenCalled();
      const emittedMessage = mockCallbacks.emitMessage.mock.calls[0][0];

      // Should indicate this is a forwarded conversation
      expect(emittedMessage.content).toContain('转发了一段聊天记录');
      expect(emittedMessage.content).toContain('Hello from user A');
      expect(emittedMessage.content).toContain('Hello from user B');
      expect(emittedMessage.messageType).toBe('chat_record');
    });

    it('should handle chat_record with post messages', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'post',
            content: JSON.stringify({
              content: [[{ tag: 'text', text: 'Rich text content' }]],
            }),
            create_time: 1700000000000,
            sender: { sender_id: { open_id: 'user_a' } },
          },
        ],
      };

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'chat_record',
            content: JSON.stringify(chatRecordContent),
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      expect(mockCallbacks.emitMessage).toHaveBeenCalled();
      const emittedMessage = mockCallbacks.emitMessage.mock.calls[0][0];

      expect(emittedMessage.content).toContain('Rich text content');
    });
  });

  describe('reply context (root_id and parent_id)', () => {
    it('should include reply context prefix when message has root_id', async () => {
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'This is a reply' }),
            create_time: Date.now(),
            root_id: 'root_message_id',
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      expect(mockCallbacks.emitMessage).toHaveBeenCalled();
      const emittedMessage = mockCallbacks.emitMessage.mock.calls[0][0];

      // Should include reply context prefix
      expect(emittedMessage.content).toContain('回复');
      expect(emittedMessage.content).toContain('root_message_id');
      expect(emittedMessage.content).toContain('This is a reply');
      expect(emittedMessage.metadata?.replyContext).toBeDefined();
    });

    it('should include both root_id and parent_id when both are present', async () => {
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'This is a nested reply' }),
            create_time: Date.now(),
            root_id: 'root_message_id',
            parent_id: 'parent_message_id',
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      expect(mockCallbacks.emitMessage).toHaveBeenCalled();
      const emittedMessage = mockCallbacks.emitMessage.mock.calls[0][0];

      // Should include both IDs in the prefix
      expect(emittedMessage.content).toContain('根消息ID');
      expect(emittedMessage.content).toContain('父消息ID');
      expect(emittedMessage.content).toContain('root_message_id');
      expect(emittedMessage.content).toContain('parent_message_id');
      expect(emittedMessage.metadata?.replyContext).toEqual({
        rootId: 'root_message_id',
        parentId: 'parent_message_id',
      });
    });

    it('should not include reply prefix when message has no root_id or parent_id', async () => {
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'This is a regular message' }),
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      expect(mockCallbacks.emitMessage).toHaveBeenCalled();
      const emittedMessage = mockCallbacks.emitMessage.mock.calls[0][0];

      // Should NOT include reply context
      expect(emittedMessage.content).not.toContain('回复');
      expect(emittedMessage.content).toBe('This is a regular message');
      expect(emittedMessage.metadata?.replyContext).toBeUndefined();
    });

    it('should handle parent_id only (without root_id)', async () => {
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'Reply with only parent_id' }),
            create_time: Date.now(),
            parent_id: 'parent_message_id',
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      expect(mockCallbacks.emitMessage).toHaveBeenCalled();
      const emittedMessage = mockCallbacks.emitMessage.mock.calls[0][0];

      // Should use parent_id as root_id fallback
      expect(emittedMessage.content).toContain('回复');
      expect(emittedMessage.content).toContain('parent_message_id');
      expect(emittedMessage.metadata?.replyContext).toBeDefined();
    });
  });
});
