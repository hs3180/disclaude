/**
 * Tests for FeishuChannel message sending with threadId support.
 *
 * Issue #1619: Verify that doSendMessage() correctly handles threadId
 * by using client.im.message.reply() instead of always using create().
 *
 * @see Issue #1619 - send_interactive ignores threadId
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

// Mock WsConnectionManager
const mockWsConnectionManager = vi.hoisted(() => ({
  state: 'connected' as const,
  on: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  isHealthy: vi.fn(() => true),
  getMetrics: vi.fn(() => ({})),
  recordMessageReceived: vi.fn(),
}));

// TODO(#1619): Replace vi.mock() with nock VCR per Issue #918.
// The test architecture injects a mock client directly, making nock integration
// non-trivial. This should be rewritten in a follow-up.
// eslint-disable-next-line no-restricted-syntax
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
  EventDispatcher: vi.fn(() => ({
    register: vi.fn(() => ({
      register: vi.fn(() => ({ register: vi.fn() })),
    })),
  })),
  LoggerLevel: { info: 1, debug: 2 },
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
    DEFAULT_CHANNEL_CAPABILITIES: {
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
    },
  };
});

vi.mock('./feishu/index.js', () => ({
  PassiveModeManager: vi.fn(() => ({
    isPassiveModeDisabled: vi.fn(() => false),
    setPassiveModeDisabled: vi.fn(),
    getPassiveModeDisabledChats: vi.fn(() => []),
  })),
  MentionDetector: vi.fn(() => ({
    setClient: vi.fn(),
    fetchBotInfo: vi.fn(),
    getBotInfo: vi.fn(() => ({ open_id: 'bot_open_id', name: 'TestBot' })),
  })),
  WelcomeHandler: vi.fn(() => ({
    handleP2PChatEntered: vi.fn(),
    handleChatMemberAdded: vi.fn(),
    setWelcomeService: vi.fn(),
  })),
  MessageHandler: vi.fn(() => ({
    handleMessageReceive: vi.fn(),
    handleCardAction: vi.fn(),
    clearClient: vi.fn(),
    initialize: vi.fn(),
  })),
  messageLogger: { init: vi.fn() },
  WsConnectionManager: vi.fn(() => mockWsConnectionManager),
}));

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn(() => ({ dispose: vi.fn() })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn(() => null),
}));

import { FeishuChannel } from './feishu-channel.js';

describe('FeishuChannel doSendMessage — Issue #1619', () => {
  let channel: FeishuChannel;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    channel = new FeishuChannel({ appId: 'test-app-id', appSecret: 'test-secret' });

    // Set channel to running state (required by sendMessage validation)
    (channel as any)._status = 'running';

    // Create a mock Feishu client and inject it
    mockClient = {
      im: {
        message: {
          create: vi.fn().mockResolvedValue({
            data: { message_id: 'om_new_message_123' },
          }),
          reply: vi.fn().mockResolvedValue({
            data: { message_id: 'om_reply_message_456' },
          }),
        },
        image: {
          create: vi.fn(),
        },
        file: {
          create: vi.fn(),
        },
      },
    };

    // Access private client property via (channel as any)
    (channel as any).client = mockClient;
  });

  describe('thread reply support (threadId)', () => {
    it('should use reply API when threadId is provided for text messages', async () => {
      const messageId = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Hello',
        threadId: 'om_parent_message',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'om_parent_message' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(messageId).toBe('om_reply_message_456');
    });

    it('should use reply API when threadId is provided for card messages', async () => {
      const card = { config: { wide_screen_mode: true }, elements: [] };
      const messageId = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'card',
        card,
        threadId: 'om_parent_message',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'om_parent_message' },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(messageId).toBe('om_reply_message_456');
    });

    it('should use create API when threadId is not provided', async () => {
      const messageId = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Hello',
      });

      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(messageId).toBe('om_new_message_123');
    });

    it('should use create API when threadId is undefined', async () => {
      await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Hello',
        threadId: undefined,
      });

      expect(mockClient.im.message.create).toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
    });

    it('should use create API when threadId is empty string', async () => {
      await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Hello',
        threadId: '',
      });

      // Empty string is falsy, so it should use create
      expect(mockClient.im.message.create).toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
    });
  });

  describe('return value — real message ID', () => {
    it('should return real messageId from create API for text messages', async () => {
      const messageId = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Test',
      });
      expect(messageId).toBe('om_new_message_123');
    });

    it('should return real messageId from create API for card messages', async () => {
      const messageId = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'card',
        card: {},
      });
      expect(messageId).toBe('om_new_message_123');
    });

    it('should return real messageId from reply API', async () => {
      const messageId = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Reply',
        threadId: 'om_parent',
      });
      expect(messageId).toBe('om_reply_message_456');
    });

    it('should return void for done messages', async () => {
      const result = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'done',
      });
      expect(result).toBeUndefined();
    });
  });

  describe('offline queue', () => {
    it('should queue message when WebSocket is reconnecting', async () => {
      // Set WS state to reconnecting
      mockWsConnectionManager.state = 'reconnecting';
      // Inject WsConnectionManager (normally set during doStart)
      (channel as any).wsConnectionManager = mockWsConnectionManager;

      const result = await channel.sendMessage({
        chatId: 'oc_test_chat',
        type: 'text',
        text: 'Queued',
        threadId: 'om_parent',
      });

      // Should not call either API
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });
});
