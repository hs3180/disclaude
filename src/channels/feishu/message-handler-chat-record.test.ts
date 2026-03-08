/**
 * Tests for Issue #1123: Optimize chat_record message type parsing.
 *
 * This test file covers:
 * 1. Parsing chat_record message type (forwarded conversations)
 * 2. Formatting with sender and timestamp information
 * 3. Handling various message types within chat_record
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

describe('MessageHandler - Issue #1123: chat_record message type', () => {
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
      isBotMentioned: vi.fn().mockReturnValue(true),
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

  describe('chat_record message type parsing', () => {
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
      expect(emittedMessage.metadata?.isForwardedChatRecord).toBe(true);
    });

    it('should include sender information in formatted output', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Test message' }),
            create_time: 1700000000000,
            sender: { sender_id: { open_id: 'specific_user_id' } },
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

      // Should include sender ID
      expect(emittedMessage.content).toContain('specific_user_id');
    });

    it('should include formatted timestamp in output', async () => {
      const testTimestamp = 1700000000000; // Known timestamp
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Timestamped message' }),
            create_time: testTimestamp,
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

      // Should include a formatted date (the exact format depends on locale)
      expect(emittedMessage.content).toContain('2023');
    });

    it('should handle chat_record with post (rich text) messages', async () => {
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

    it('should handle chat_record with missing sender info gracefully', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message without sender' }),
            create_time: 1700000000000,
            // No sender field
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

      // Should show default "未知用户" for missing sender
      expect(emittedMessage.content).toContain('未知用户');
    });

    it('should handle chat_record with missing timestamp gracefully', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message without timestamp' }),
            // No create_time field
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

      // Should still include the message
      expect(emittedMessage.content).toContain('Message without timestamp');
    });

    it('should handle invalid chat_record content gracefully', async () => {
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'chat_record',
            content: 'invalid json content',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      // Should not emit a message for invalid content
      expect(mockCallbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle chat_record with empty messages array', async () => {
      const chatRecordContent = {
        messages: [],
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

      // Should not emit a message for empty messages array
      expect(mockCallbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle chat_record with mixed message types', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Text message' }),
            create_time: 1700000000000,
            sender: { sender_id: { open_id: 'user_a' } },
          },
          {
            message_id: 'msg_2',
            message_type: 'post',
            content: JSON.stringify({
              content: [[{ tag: 'text', text: 'Post message' }]],
            }),
            create_time: 1700000001000,
            sender: { sender_id: { open_id: 'user_b' } },
          },
          {
            message_id: 'msg_3',
            message_type: 'image',
            content: JSON.stringify({ file_key: 'image_key' }),
            create_time: 1700000002000,
            sender: { sender_id: { open_id: 'user_c' } },
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

      // Should include text and post content
      expect(emittedMessage.content).toContain('Text message');
      expect(emittedMessage.content).toContain('Post message');
      // Should indicate image type
      expect(emittedMessage.content).toContain('[image]');
    });

    it('should separate messages with divider', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'First message' }),
            create_time: 1700000000000,
            sender: { sender_id: { open_id: 'user_a' } },
          },
          {
            message_id: 'msg_2',
            message_type: 'text',
            content: JSON.stringify({ text: 'Second message' }),
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

      // Messages should be separated by divider
      expect(emittedMessage.content).toContain('---');
    });
  });
});
