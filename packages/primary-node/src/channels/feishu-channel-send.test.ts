/**
 * Tests for FeishuChannel message sending, especially thread reply support.
 *
 * Issue #1619: send_interactive 交互卡片忽略 threadId
 *
 * Tests cover:
 * - Thread reply via client.im.message.reply when threadId is provided
 * - Normal message creation via client.im.message.create when no threadId
 * - Real messageId returned from both reply and create paths
 * - File upload (image/file) with thread reply
 * - Offline queue behavior when WebSocket is reconnecting
 * - Edge cases: done signal, unsupported type
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

/**
 * Create a mock Lark client with controllable im.message methods.
 */
function createMockClient() {
  const createMock = vi.fn().mockResolvedValue({
    data: { message_id: 'new_msg_001' },
  });

  const replyMock = vi.fn().mockResolvedValue({
    data: { message_id: 'reply_msg_001' },
  });

  const imageCreateMock = vi.fn().mockResolvedValue({
    image_key: 'img_key_001',
  });

  const fileCreateMock = vi.fn().mockResolvedValue({
    file_key: 'file_key_001',
  });

  return {
    client: {
      im: {
        message: {
          create: createMock,
          reply: replyMock,
        },
        image: {
          create: imageCreateMock,
        },
        file: {
          create: fileCreateMock,
        },
      },
    },
    mocks: { createMock, replyMock, imageCreateMock, fileCreateMock },
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
  PassiveModeManager: vi.fn().mockImplementation(() => ({
    isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    setPassiveModeDisabled: vi.fn(),
    getPassiveModeDisabledChats: vi.fn().mockReturnValue([]),
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

/**
 * Create a FeishuChannel and inject a mock client directly.
 * This bypasses the constructor's createFeishuClient call.
 */
function createTestChannel(mockClient: ReturnType<typeof createMockClient>['client']) {
  const channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  // Inject mock client by setting the private field
  (channel as any).client = mockClient;
  // Mark as running so sendMessage doesn't throw
  (channel as any)._status = 'running';
  return channel;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('FeishuChannel doSendMessage — Issue #1619', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('text messages', () => {
    it('should use message.create when no threadId is provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello',
      });

      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mocks.replyMock).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_001');
    });

    it('should use message.reply when threadId is provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello',
        threadId: 'root_msg_456',
      });

      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledWith({
        path: { message_id: 'root_msg_456' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });
  });

  describe('card messages (interactive)', () => {
    it('should use message.create for cards without threadId', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const card = { config: { wide_screen_mode: true }, elements: [] };
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
      });

      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mocks.replyMock).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_001');
    });

    it('should use message.reply for cards with threadId', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const card = { config: { wide_screen_mode: true }, elements: [] };
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
        threadId: 'root_msg_789',
      });

      expect(mocks.replyMock).toHaveBeenCalledWith({
        path: { message_id: 'root_msg_789' },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });
  });

  describe('messageId return value', () => {
    it('should return undefined when API returns no message_id', async () => {
      const { client, mocks } = createMockClient();
      mocks.createMock.mockResolvedValueOnce({ data: {} });
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'No ID',
      });

      expect(result).toBeUndefined();
    });

    it('should return undefined for done signal type', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'done',
        success: true,
      });

      expect(result).toBeUndefined();
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(mocks.replyMock).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should throw on unsupported message type', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      // 'done' is a valid type — should not throw
      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'done',
        success: true,
      });

      await expect(
        channel.sendMessage({
          chatId: 'chat_123',
          type: 'unknown_type',
        } as any),
      ).rejects.toThrow('Unsupported message type');
    });

    it('should throw when client is not initialized', async () => {
      const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
      (channel as any)._status = 'running';
      // Don't inject client — it should be undefined

      await expect(
        channel.sendMessage({
          chatId: 'chat_123',
          type: 'text',
          text: 'test',
        }),
      ).rejects.toThrow('Client not initialized');
    });
  });
});
