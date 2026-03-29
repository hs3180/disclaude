/**
 * Tests for FeishuChannel.doSendMessage thread reply support.
 *
 * Issue #1619: send_interactive ignores threadId.
 * Tests that FeishuChannel correctly uses message.reply() when threadId is
 * provided and message.create() when it's not. Also tests that real message
 * IDs are returned from the API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// Mock the feishu module dependencies
vi.mock('./feishu/index.js', () => ({
  PassiveModeManager: vi.fn().mockImplementation(() => ({
    isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    setPassiveModeDisabled: vi.fn(),
    getPassiveModeDisabledChats: vi.fn().mockReturnValue([]),
  })),
  MentionDetector: vi.fn().mockImplementation(() => ({
    setClient: vi.fn(),
    fetchBotInfo: vi.fn().mockResolvedValue(undefined),
    getBotInfo: vi.fn().mockReturnValue({ open_id: 'bot-open-id' }),
  })),
  WelcomeHandler: vi.fn().mockImplementation(() => ({
    handleP2PChatEntered: vi.fn(),
    handleChatMemberAdded: vi.fn(),
    setWelcomeService: vi.fn(),
  })),
  MessageHandler: vi.fn().mockImplementation(() => ({
    handleMessageReceive: vi.fn(),
    handleCardAction: vi.fn(),
    initialize: vi.fn(),
    clearClient: vi.fn(),
  })),
  messageLogger: { init: vi.fn().mockResolvedValue(undefined) },
  WsConnectionManager: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    state: 'connected',
    isHealthy: () => true,
    recordMessageReceived: vi.fn(),
    getMetrics: vi.fn().mockReturnValue({}),
    on: vi.fn(),
  })),
}));

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn().mockReturnValue({
    im: {
      message: {
        create: vi.fn(),
        reply: vi.fn(),
      },
    },
  }),
  dissolveChat: vi.fn(),
  GroupService: vi.fn().mockImplementation(() => ({
    createGroup: vi.fn(),
    unregisterGroup: vi.fn(),
  })),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
  Config: { FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' },
  WS_HEALTH: {
    OFFLINE_QUEUE: { MAX_SIZE: 100, MAX_MESSAGE_AGE_MS: 300000 },
  },
  LoggerLevel: { info: 0 },
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnValue({
      register: vi.fn().mockReturnValue({
        register: vi.fn().mockReturnValue({
          register: vi.fn().mockReturnValue({
            register: vi.fn().mockReturnThis(),
          }),
        }),
      }),
    }),
  })),
}));

function createMockClient() {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'new-msg-123' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'reply-msg-456' } }),
      },
    },
  };
}

describe('FeishuChannel - Issue #1619 thread reply support', () => {
  let channel: FeishuChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  });

  describe('doSendMessage - thread reply routing', () => {
    it('should use message.create() when threadId is not provided (text)', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;

      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Hello',
      });

      expect(mockClient.im.message.create).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat-001',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(result).toBe('new-msg-123');
    });

    it('should use message.reply() when threadId is provided (text)', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;

      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Reply in thread',
        threadId: 'parent-msg-789',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent-msg-789' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Reply in thread' }),
        },
      });
      expect(result).toBe('reply-msg-456');
    });

    it('should use message.create() when threadId is not provided (card)', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;

      const card = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Card' } }] };
      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'card',
        card,
      });

      expect(mockClient.im.message.create).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBe('new-msg-123');
    });

    it('should use message.reply() when threadId is provided (card)', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;

      const card = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Card' } }] };
      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'card',
        card,
        threadId: 'parent-msg-789',
      });

      expect(mockClient.im.message.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBe('reply-msg-456');
    });

    it('should return real messageId from API', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;

      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Hello',
      });

      expect(result).toBe('new-msg-123');
    });

    it('should return undefined for done message type', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;

      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'done',
      });

      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(mockClient.im.message.reply).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should return undefined when WebSocket is reconnecting (offline queue)', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;
      (channel as any).wsConnectionManager = { state: 'reconnecting' };

      const result = await (channel as any).doSendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Queued message',
      });

      expect(mockClient.im.message.create).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe('sendMessage - return type', () => {
    it('should return messageId from doSendMessage', async () => {
      const mockClient = createMockClient();
      (channel as any).client = mockClient;
      // Simulate channel in running state
      (channel as any)._status = 'running';

      const result = await channel.sendMessage({
        chatId: 'chat-001',
        type: 'text',
        text: 'Hello',
      });

      expect(result).toBe('new-msg-123');
    });
  });
});
