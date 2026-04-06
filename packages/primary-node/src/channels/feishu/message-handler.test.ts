/**
 * Unit tests for MessageHandler small group detection.
 *
 * Issue #2052: Auto-disable passive mode for 2-member group chats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from './message-handler.js';
import { PassiveModeManager } from './passive-mode.js';
import type { MessageCallbacks } from './message-handler.js';

/**
 * Create a mock Feishu client that returns configurable member counts.
 */
function createMockClient(memberCount: { userCount: string; botCount: string } | { error: Error }) {
  const chatApi = 'error' in memberCount
    ? { get: vi.fn().mockRejectedValue(memberCount.error) }
    : { get: vi.fn().mockResolvedValue({
        code: 0,
        data: {
          user_count: memberCount.userCount,
          bot_count: memberCount.botCount,
        },
      }) };

  return {
    im: {
      chat: chatApi,
      message: { get: vi.fn() },
      messageReaction: { create: vi.fn() },
      messageResource: { get: vi.fn() },
    },
  } as unknown as import('@larksuiteoapi/node-sdk').Client;
}

/**
 * Create a mock MentionDetector that never detects bot mentions.
 */
function createMockMentionDetector() {
  return {
    isBotMentioned: vi.fn().mockReturnValue(false),
    setClient: vi.fn(),
    fetchBotInfo: vi.fn(),
    getBotInfo: vi.fn().mockReturnValue({ open_id: 'bot_test' }),
  };
}

/**
 * Create a mock MessageCallbacks.
 */
function createMockCallbacks(): MessageCallbacks {
  return {
    emitMessage: vi.fn().mockResolvedValue(undefined),
    emitControl: vi.fn().mockResolvedValue({ success: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a standard test MessageHandler.
 */
function createTestHandler(client: ReturnType<typeof createMockClient>) {
  const passiveModeManager = new PassiveModeManager();
  const mentionDetector = createMockMentionDetector();
  const callbacks = createMockCallbacks();

  const handler = new MessageHandler({
    passiveModeManager,
    mentionDetector,
    // InteractionManager is typed strictly — cast to any for test simplicity
    interactionManager: {
      handleAction: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    } as any,
    callbacks,
    isRunning: () => true,
    hasControlHandler: () => false,
  });

  handler.initialize(client);

  return { handler, passiveModeManager, callbacks, mentionDetector };
}

/**
 * Create a minimal message event for testing.
 */
function createMessageEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'user_test' } },
    message: {
      message_id: 'msg_test_1',
      chat_id: 'oc_test_group',
      chat_type: 'group',
      content: JSON.stringify({ text: 'hello' }),
      message_type: 'text',
      create_time: Date.now() - 1000,
      mentions: [],
      parent_id: undefined,
      ...overrides,
    },
  };
}

// Mock messageLogger to bypass deduplication and logging
vi.mock('./message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: vi.fn().mockReturnValue(false),
    logIncomingMessage: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    getChatHistory: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('MessageHandler small group detection (Issue #2052)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('2-member group (bot + 1 user)', () => {
    it('should pass through messages without @mention in 2-member groups', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      // Message should be emitted (not filtered by passive mode)
      const emitMock = callbacks.emitMessage as any;
      expect(emitMock).toHaveBeenCalledTimes(1);
      const emitted = emitMock.mock.calls[0][0] as any;
      expect(emitted.chatId).toBe('oc_test_group');
      expect(emitted.content).toBe('hello');
    });

    it('should auto-disable passive mode in PassiveModeManager', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler, passiveModeManager } = createTestHandler(client);

      // Initially passive mode is enabled (default)
      expect(passiveModeManager.isPassiveModeDisabled('oc_test_group')).toBe(false);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      // After processing, passive mode should be auto-disabled
      expect(passiveModeManager.isPassiveModeDisabled('oc_test_group')).toBe(true);
    });

    it('should call chat.get API to check member count', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      expect((client as any).im.chat.get).toHaveBeenCalledWith({
        path: { chat_id: 'oc_test_group' },
      });
    });
  });

  describe('3+ member groups', () => {
    it('should filter messages without @mention in 3+ member groups', async () => {
      const client = createMockClient({ userCount: '2', botCount: '1' });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      // Message should NOT be emitted (filtered by passive mode)
      expect(callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should filter messages in large groups (10+ members)', async () => {
      const client = createMockClient({ userCount: '10', botCount: '1' });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      expect(callbacks.emitMessage).not.toHaveBeenCalled();
    });
  });

  describe('API failure handling', () => {
    it('should filter messages when chat.get API fails (safe default)', async () => {
      const client = createMockClient({ error: new Error('API rate limit') });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      // Message should be filtered (safe default: passive mode stays on)
      expect(callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should filter messages when client returns no data', async () => {
      const client = createMockClient({ error: new Error('no data') });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      expect(callbacks.emitMessage).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should cache member count and not call API on subsequent messages', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler, callbacks } = createTestHandler(client);

      // First message - triggers API call
      const event1 = createMessageEvent({ message_id: 'msg_1' });
      await handler.handleMessageReceive(event1 as any);
      expect((client as any).im.chat.get).toHaveBeenCalledTimes(1);
      expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);

      // Reset mock for second message
      (callbacks.emitMessage as any).mockClear();

      // Second message in same group - should use cached result, no API call
      const event2 = createMessageEvent({ message_id: 'msg_2' });
      await handler.handleMessageReceive(event2 as any);

      // Passive mode was already disabled, so no API call needed
      expect((client as any).im.chat.get).toHaveBeenCalledTimes(1); // Still 1, not 2
      expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should call API again for different groups', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler } = createTestHandler(client);

      // First group
      const event1 = createMessageEvent({ message_id: 'msg_1', chat_id: 'oc_group_1' });
      await handler.handleMessageReceive(event1 as any);
      expect((client as any).im.chat.get).toHaveBeenCalledTimes(1);

      // Second group (3+ members) - filtered, triggers API call
      const client2 = createMockClient({ userCount: '3', botCount: '1' });
      handler.initialize(client2);
      const event2 = createMessageEvent({ message_id: 'msg_2', chat_id: 'oc_group_2' });
      await handler.handleMessageReceive(event2 as any);
      expect((client2 as any).im.chat.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('should still respect @mention even in small groups', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler, callbacks, mentionDetector } = createTestHandler(client);

      // Make the bot appear to be mentioned
      (mentionDetector.isBotMentioned as any).mockReturnValue(true);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      // Message should be emitted (bot was mentioned)
      expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);
      // API should NOT be called (mention bypasses passive mode check)
      expect((client as any).im.chat.get).not.toHaveBeenCalled();
    });

    it('should not apply to p2p (private) chats', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent({ chat_type: 'p2p' });
      await handler.handleMessageReceive(event as any);

      // P2P messages bypass passive mode entirely
      expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);
      // API should NOT be called for p2p chats
      expect((client as any).im.chat.get).not.toHaveBeenCalled();
    });

    it('should handle /passive commands without triggering API call', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler } = createTestHandler(client);

      const event = createMessageEvent({
        content: JSON.stringify({ text: '/passive off' }),
      });
      await handler.handleMessageReceive(event as any);

      // /passive command should bypass passive mode filter
      expect((client as any).im.chat.get).not.toHaveBeenCalled();
    });

    it('should handle single-member group (bot only) gracefully', async () => {
      const client = createMockClient({ userCount: '0', botCount: '1' });
      const { handler, callbacks } = createTestHandler(client);

      const event = createMessageEvent();
      await handler.handleMessageReceive(event as any);

      // 1 member (bot only) is ≤ threshold, so passive mode is disabled
      expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('isSmallGroup (via private access)', () => {
    it('should return true for 2 members', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler } = createTestHandler(client);

      const result = await (handler as any).isSmallGroup('oc_test');
      expect(result).toBe(true);
    });

    it('should return false for 3 members', async () => {
      const client = createMockClient({ userCount: '2', botCount: '1' });
      const { handler } = createTestHandler(client);

      const result = await (handler as any).isSmallGroup('oc_test');
      expect(result).toBe(false);
    });

    it('should return true for 1 member (bot only)', async () => {
      const client = createMockClient({ userCount: '0', botCount: '1' });
      const { handler } = createTestHandler(client);

      const result = await (handler as any).isSmallGroup('oc_test');
      expect(result).toBe(true);
    });

    it('should return false on API error', async () => {
      const client = createMockClient({ error: new Error('fail') });
      const { handler } = createTestHandler(client);

      const result = await (handler as any).isSmallGroup('oc_test');
      expect(result).toBe(false);
    });
  });

  describe('fetchMemberCount (via private access)', () => {
    it('should parse user_count and bot_count as strings', async () => {
      const client = createMockClient({ userCount: '5', botCount: '2' });
      const { handler } = createTestHandler(client);

      const count = await (handler as any).fetchMemberCount('oc_test');
      expect(count).toBe(7);
    });

    it('should handle missing user_count/bot_count', async () => {
      const client = {
        im: {
          chat: {
            get: vi.fn().mockResolvedValue({
              code: 0,
              data: {},
            }),
          },
        },
      } as unknown as import('@larksuiteoapi/node-sdk').Client;

      const { handler } = createTestHandler(client);

      const count = await (handler as any).fetchMemberCount('oc_test');
      expect(count).toBe(0);
    });

    it('should return Infinity when client is not initialized', async () => {
      const client = createMockClient({ userCount: '1', botCount: '1' });
      const { handler } = createTestHandler(client);

      // Clear client
      handler.clearClient();

      const count = await (handler as any).fetchMemberCount('oc_test');
      expect(count).toBe(Infinity);
    });
  });
});
