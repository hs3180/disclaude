/**
 * Tests for MessageHandler chat_record parsing.
 * Issue #1123: Support chat_record message type for forwarded chat history
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../message-handler.js';
import type { FeishuEventData } from '../../../types/platform.js';

// Mock dependencies
vi.mock('../../../services/index.js', () => ({
  getLarkClientService: vi.fn(() => ({
    getClient: vi.fn(() => ({})),
    getMessage: vi.fn(),
  })),
  isLarkClientServiceInitialized: vi.fn(() => true),
}));

vi.mock('../../../file-transfer/inbound/index.js', () => ({
  attachmentManager: {
    getAttachments: vi.fn(() => []),
  },
  downloadFile: vi.fn(),
}));

vi.mock('../../../feishu/message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: vi.fn(() => false),
    logIncomingMessage: vi.fn(),
  },
}));

vi.mock('../../../feishu/filtered-message-forwarder.js', () => ({
  filteredMessageForwarder: {
    setMessageSender: vi.fn(),
    forward: vi.fn(),
  },
}));

vi.mock('../../../platforms/feishu/feishu-file-handler.js', () => ({
  FeishuFileHandler: vi.fn(() => ({
    handleFileMessage: vi.fn(),
    buildUploadPrompt: vi.fn(),
  })),
}));

vi.mock('../../../platforms/feishu/feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn(() => ({
    addReaction: vi.fn(),
    sendText: vi.fn(),
  })),
}));

vi.mock('../../../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn(() => ({
    handleAction: vi.fn(),
  })),
}));

vi.mock('../../../ipc/unix-socket-client.js', () => ({
  getIpcClient: vi.fn(() => ({
    isConnected: vi.fn(() => false),
  })),
}));

describe('MessageHandler - chat_record parsing', () => {
  let handler: MessageHandler;
  let emitMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    emitMessageMock = vi.fn();

    const passiveModeManager = {
      isPassiveModeDisabled: vi.fn(() => false),
    } as unknown as { isPassiveModeDisabled: (chatId: string) => boolean };

    const mentionDetector = {
      isBotMentioned: vi.fn(() => false),
    } as unknown as { isBotMentioned: (mentions: unknown) => boolean };

    const interactionManager = {} as unknown as { handleAction: () => Promise<boolean> };

    handler = new MessageHandler({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks: {
        emitMessage: emitMessageMock,
        emitControl: vi.fn(),
        sendMessage: vi.fn(),
      },
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    handler.initialize();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('chat_record message type', () => {
    it('should parse chat_record with text messages', async () => {
      const chatRecordContent = JSON.stringify({
        messages: [
          {
            message_id: 'msg-1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello from user A' }),
            create_time: 1704067200000, // 2024-01-01 00:00:00 UTC
            sender: { sender_id: { open_id: 'user_a' } },
          },
          {
            message_id: 'msg-2',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello from user B' }),
            create_time: 1704067260000, // 2024-01-01 00:01:00 UTC
            sender: { sender_id: { open_id: 'user_b' } },
          },
        ],
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      expect(emitMessageMock).toHaveBeenCalledTimes(1);
      const [[callArgs]] = emitMessageMock.mock.calls;

      expect(callArgs.messageType).toBe('chat_record');
      expect(callArgs.content).toContain('[用户转发了一段聊天记录]');
      expect(callArgs.content).toContain('user_a');
      expect(callArgs.content).toContain('Hello from user A');
      expect(callArgs.content).toContain('user_b');
      expect(callArgs.content).toContain('Hello from user B');
      expect(callArgs.metadata.isChatRecord).toBe(true);
    });

    it('should parse chat_record with post messages', async () => {
      const chatRecordContent = JSON.stringify({
        messages: [
          {
            message_id: 'msg-1',
            message_type: 'post',
            content: JSON.stringify({
              content: [[{ tag: 'text', text: 'Rich text message' }]],
            }),
            create_time: 1704067200000,
            sender: { sender_id: { user_id: 'user_x' } },
          },
        ],
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      expect(emitMessageMock).toHaveBeenCalledTimes(1);
      const [[callArgs]] = emitMessageMock.mock.calls;

      expect(callArgs.content).toContain('Rich text message');
    });

    it('should handle empty messages array', async () => {
      const chatRecordContent = JSON.stringify({
        messages: [],
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      // Should not emit message for empty chat_record
      expect(emitMessageMock).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON content', async () => {
      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: 'not valid json',
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      // Should not emit message for invalid content
      expect(emitMessageMock).not.toHaveBeenCalled();
    });

    it('should handle missing messages field', async () => {
      const chatRecordContent = JSON.stringify({
        someOtherField: 'value',
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      // Should not emit message for missing messages field
      expect(emitMessageMock).not.toHaveBeenCalled();
    });

    it('should use fallback sender ID when open_id is missing', async () => {
      const chatRecordContent = JSON.stringify({
        messages: [
          {
            message_id: 'msg-1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message with user_id only' }),
            create_time: 1704067200000,
            sender: { sender_id: { user_id: 'fallback_user' } },
          },
        ],
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      expect(emitMessageMock).toHaveBeenCalledTimes(1);
      const [[callArgs]] = emitMessageMock.mock.calls;

      expect(callArgs.content).toContain('fallback_user');
    });

    it('should show unknown user when sender info is missing', async () => {
      const chatRecordContent = JSON.stringify({
        messages: [
          {
            message_id: 'msg-1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message without sender' }),
            create_time: 1704067200000,
          },
        ],
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      expect(emitMessageMock).toHaveBeenCalledTimes(1);
      const [[callArgs]] = emitMessageMock.mock.calls;

      expect(callArgs.content).toContain('未知用户');
    });

    it('should format timestamps correctly', async () => {
      const chatRecordContent = JSON.stringify({
        messages: [
          {
            message_id: 'msg-1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Test message' }),
            create_time: 1704067200000, // Fixed timestamp
            sender: { sender_id: { open_id: 'user_a' } },
          },
        ],
      });

      const eventData: FeishuEventData = {
        event: {
          message: {
            message_id: 'test-msg-id',
            chat_id: 'test-chat-id',
            chat_type: 'p2p',
            content: chatRecordContent,
            message_type: 'chat_record',
            create_time: Date.now(),
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'sender-open-id' },
          },
        },
      };

      await handler.handleMessageReceive(eventData);

      expect(emitMessageMock).toHaveBeenCalledTimes(1);
      const [[callArgs]] = emitMessageMock.mock.calls;

      // Should contain formatted date (format may vary by locale)
      expect(callArgs.content).toMatch(/\d{4}/); // Year
    });
  });
});
