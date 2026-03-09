/**
 * Tests for MessageHandler.
 * Issue #1123: Enhanced chat_record message type support
 *
 * Tests the message handling functionality for Feishu channel:
 * - chat_record message type parsing and formatting
 * - Sender and timestamp extraction
 * - Formatted output generation
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

vi.mock('../../services/index.js', () => ({
  getLarkClientService: vi.fn(() => ({
    getClient: vi.fn().mockReturnValue({}),
    getMessage: vi.fn().mockResolvedValue(null),
  })),
  isLarkClientServiceInitialized: vi.fn().mockReturnValue(true),
}));

vi.mock('../../nodes/commands/command-registry.js', () => ({
  getCommandRegistry: vi.fn(() => ({
    has: vi.fn().mockReturnValue(false),
  })),
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

describe('MessageHandler - Issue #1123: chat_record', () => {
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

  describe('chat_record message type', () => {
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should indicate this is a forwarded conversation
      expect(emittedMessage.content).toContain('转发了一段聊天记录');
      expect(emittedMessage.content).toContain('Hello from user A');
      expect(emittedMessage.content).toContain('Hello from user B');
      expect(emittedMessage.messageType).toBe('chat_record');
    });

    it('should include sender information in formatted output', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Test message' }),
            create_time: 1700000000000,
            sender: { sender_id: { open_id: 'test_user_123' } },
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should include sender ID
      expect(emittedMessage.content).toContain('test_user_123');
    });

    it('should include formatted timestamp in output', async () => {
      const testTimestamp = 1704067200000; // 2024-01-01 00:00:00 UTC
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'New year message' }),
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should include formatted date (2024/01/01)
      expect(emittedMessage.content).toContain('2024/');
    });

    it('should handle messages without timestamp', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message without timestamp' }),
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should still include the message content
      expect(emittedMessage.content).toContain('Message without timestamp');
    });

    it('should handle messages without sender info', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Anonymous message' }),
            create_time: 1700000000000,
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should use 'unknown' as sender
      expect(emittedMessage.content).toContain('unknown');
      expect(emittedMessage.content).toContain('Anonymous message');
    });

    it('should handle post type messages in chat_record', async () => {
      const chatRecordContent = {
        messages: [
          {
            message_id: 'msg_1',
            message_type: 'post',
            content: JSON.stringify({
              content: [
                [{ tag: 'text', text: 'Rich text message' }],
              ],
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should extract text from post content
      expect(emittedMessage.content).toContain('Rich text message');
    });

    it('should separate multiple messages with divider', async () => {
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
      const [[emittedMessage]] = mockCallbacks.emitMessage.mock.calls;

      // Should have separator between messages
      expect(emittedMessage.content).toContain('---');
      expect(emittedMessage.content).toContain('First message');
      expect(emittedMessage.content).toContain('Second message');
    });

    it('should handle invalid chat_record content gracefully', async () => {
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'chat_record',
            content: 'invalid json',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      // Should not emit message for invalid content
      expect(mockCallbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle empty messages array', async () => {
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

      // Should not emit message for empty messages array
      expect(mockCallbacks.emitMessage).not.toHaveBeenCalled();
    });
  });

  describe('Issue #1232: Control command typing reaction', () => {
    it('should add typing reaction for control commands', async () => {
      // Get the mock message sender constructor and its mock implementation
      const { FeishuMessageSender } = await import('../../platforms/feishu/feishu-message-sender.js');
      const MockFeishuMessageSender = vi.mocked(FeishuMessageSender);

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: '/status' }),
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender_open_id' },
          },
        },
      });

      // The handler creates a FeishuMessageSender in initialize()
      // Get the mock instance and verify addReaction was called
      const mockInstance = MockFeishuMessageSender.mock.results[0]?.value;
      if (mockInstance) {
        expect(mockInstance.addReaction).toHaveBeenCalledWith('test-msg-id', 'Typing');
      }
    });
  });
});
