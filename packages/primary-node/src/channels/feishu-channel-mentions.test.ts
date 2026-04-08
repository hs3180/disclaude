/**
 * Tests for FeishuChannel @mention support (Issue #1742).
 *
 * Tests cover:
 * - buildPostContentWithMentions via doSendMessage with mentions
 * - Post message sent with correct rich text content when mentions provided
 * - Normal text message sent when no mentions provided
 * - Thread reply with mentions
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// ─── Mock Logger ────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── Mock Lark SDK ──────────────────────────────────────────────────────────

function createMockClient() {
  const createMock = vi.fn().mockResolvedValue({
    data: { message_id: 'new_msg_001' },
  });

  const replyMock = vi.fn().mockResolvedValue({
    data: { message_id: 'reply_msg_001' },
  });

  return {
    client: {
      im: {
        message: {
          create: createMock,
          reply: replyMock,
        },
      },
    },
    mocks: { createMock, replyMock },
  };
}

// ─── Mock Feishu platform modules ───────────────────────────────────────────

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn(() => {
    const { client } = createMockClient();
    return client;
  }),
}));

vi.mock('./feishu/index.js', () => ({
  TriggerModeManager: vi.fn().mockImplementation(() => ({
    getTriggerMode: vi.fn().mockReturnValue('mention'),
    setTriggerMode: vi.fn(),
    isAlwaysMode: vi.fn().mockReturnValue(false),
    getAlwaysModeChats: vi.fn().mockReturnValue([]),
  })),
  MentionDetector: vi.fn().mockImplementation(() => ({
    setClient: vi.fn(),
    fetchBotInfo: vi.fn().mockResolvedValue(undefined),
    getBotInfo: vi.fn().mockReturnValue(undefined),
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
    state: 'connected',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    recordMessageReceived: vi.fn(),
    getMetrics: vi.fn().mockReturnValue(undefined),
  })),
  type: {},
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestChannel(mockClient: ReturnType<typeof createMockClient>['client']) {
  const channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  (channel as any).client = mockClient;
  (channel as any)._status = 'running';
  return channel;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('FeishuChannel doSendMessage — mentions support (Issue #1742)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('text messages with mentions', () => {
    it('should send as post when mentions are provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const mentions = [
        { openId: 'ou_bot_001', name: 'Other Bot' },
        { openId: 'ou_user_001', name: 'User' },
      ];

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello everyone',
        mentions,
      });

      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'post',
          content: expect.any(String),
        },
      });

      // Verify the post content structure
      // eslint-disable-next-line prefer-destructuring
      const [callArgs] = mocks.createMock.mock.calls[0];
      const content = JSON.parse(callArgs.data.content);
      expect(content.zh_cn.title).toBe('');
      expect(content.zh_cn.content).toHaveLength(1);
      expect(content.zh_cn.content[0]).toHaveLength(3); // 2 mentions + 1 text
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_bot_001' });
      expect(content.zh_cn.content[0][1]).toEqual({ tag: 'at', user_id: 'ou_user_001' });
      expect(content.zh_cn.content[0][2]).toEqual({ tag: 'text', text: ' Hello everyone' });
      expect(result).toBe('new_msg_001');
    });

    it('should send as post with mentions and empty text', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const mentions = [{ openId: 'ou_bot_001' }];

      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        mentions,
      });

      // eslint-disable-next-line prefer-destructuring
      const [callArgs] = mocks.createMock.mock.calls[0];
      const content = JSON.parse(callArgs.data.content);
      expect(content.zh_cn.content[0]).toHaveLength(1); // only the mention, no text element
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_bot_001' });
    });

    it('should send as normal text when mentions array is empty', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'No mentions',
        mentions: [],
      });

      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'No mentions' }),
        },
      });
    });

    it('should send as normal text when mentions is undefined', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Plain text',
      });

      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Plain text' }),
        },
      });
    });

    it('should send as post with mentions in thread reply', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const mentions = [{ openId: 'ou_bot_001' }];

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Reply with mention',
        threadId: 'root_msg_456',
        mentions,
      });

      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledWith({
        path: { message_id: 'root_msg_456' },
        data: {
          msg_type: 'post',
          content: expect.any(String),
        },
      });
      expect(result).toBe('reply_msg_001');
    });

    it('should fall back to create when reply fails with mentions', async () => {
      const { client, mocks } = createMockClient();
      mocks.replyMock.mockRejectedValueOnce(new Error('Reply failed'));
      const channel = createTestChannel(client);

      const mentions = [{ openId: 'ou_bot_001' }];

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Reply with mention fallback',
        threadId: 'root_msg_456',
        mentions,
      });

      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      // Fallback should still use post type with mentions
      // eslint-disable-next-line prefer-destructuring
      const [callArgs] = mocks.createMock.mock.calls[0];
      expect(callArgs.data.msg_type).toBe('post');
      expect(result).toBe('new_msg_001');
    });

    it('should handle single mention without name', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Ping',
        mentions: [{ openId: 'ou_nobody' }],
      });

      // eslint-disable-next-line prefer-destructuring
      const [callArgs] = mocks.createMock.mock.calls[0];
      const content = JSON.parse(callArgs.data.content);
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_nobody' });
      expect(content.zh_cn.content[0][1]).toEqual({ tag: 'text', text: ' Ping' });
    });
  });
});
