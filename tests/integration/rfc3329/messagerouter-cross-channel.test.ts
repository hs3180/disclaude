/**
 * Integration test: MessageRouter cross-channel routing (RFC #3329).
 *
 * Tests the output MessageRouter's level-based routing:
 *   Admin chat receives all messages
 *   User chat receives only configured levels
 *   Broadcast to all channels
 *
 * Also tests the Input MessageRouter's unified routing for
 * UserMessage and SystemMessage sources.
 *
 * @see Issue #3662
 * @see RFC #3329
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageLevel,
  DEFAULT_USER_LEVELS,
  MessageRouter as InputMessageRouter,
  MessageRoutingError,
  type IAgentMessageHandler,
  type UserMessage,
  type SystemMessage,
} from '@disclaude/core';
import {
  MessageRouter as OutputMessageRouter,
  createDefaultRouteConfig,
  type IMessageSender,
} from '@disclaude/primary-node';

// ============================================================================
// Output MessageRouter Tests
// ============================================================================

describe('Output MessageRouter cross-channel routing', () => {
  let mockSender: IMessageSender;
  let sentMessages: Array<{ chatId: string; content: string }>;

  beforeEach(() => {
    sentMessages = [];
    mockSender = {
      sendText: vi.fn(async (chatId: string, content: string) => {
        sentMessages.push({ chatId, content });
      }),
    };
  });

  describe('Admin receives all levels', () => {
    it('should send DEBUG messages to admin only', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Debug info', level: MessageLevel.DEBUG });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('oc_admin');
    });

    it('should send PROGRESS messages to admin only', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Progress update', level: MessageLevel.PROGRESS });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('oc_admin');
    });

    it('should send INFO messages to admin only', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Info message', level: MessageLevel.INFO });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('oc_admin');
    });
  });

  describe('User receives configured levels', () => {
    it('should send RESULT to both admin and user', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Task completed!', level: MessageLevel.RESULT });

      expect(sentMessages).toHaveLength(2);
      const chatIds = sentMessages.map(m => m.chatId);
      expect(chatIds).toContain('oc_admin');
      expect(chatIds).toContain('oc_user');
    });

    it('should send ERROR to both admin and user', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Something went wrong', level: MessageLevel.ERROR });

      expect(sentMessages).toHaveLength(2);
      const chatIds = sentMessages.map(m => m.chatId);
      expect(chatIds).toContain('oc_admin');
      expect(chatIds).toContain('oc_user');
    });

    it('should send NOTICE to both admin and user', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Notification', level: MessageLevel.NOTICE });

      expect(sentMessages).toHaveLength(2);
    });
  });

  describe('Same admin and user chat (dedup)', () => {
    it('should not send duplicate messages when admin and user are the same chat', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_same_chat',
          userChatId: 'oc_same_chat',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      await router.route({ content: 'Result', level: MessageLevel.RESULT });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('oc_same_chat');
    });
  });

  describe('Dynamic level updates', () => {
    it('should reflect level changes in routing', async () => {
      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: mockSender,
      });

      // Initially RESULT goes to both
      await router.route({ content: 'Result 1', level: MessageLevel.RESULT });
      expect(sentMessages).toHaveLength(2);

      // Restrict user to only ERROR
      router.setUserLevels([MessageLevel.ERROR]);
      sentMessages.length = 0;

      // RESULT now goes to admin only
      await router.route({ content: 'Result 2', level: MessageLevel.RESULT });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe('oc_admin');
    });
  });

  describe('Error resilience', () => {
    it('should continue sending to other targets on send failure', async () => {
      const failSender: IMessageSender = {
        sendText: vi.fn(async (chatId: string) => {
          if (chatId === 'oc_admin') {
            throw new Error('Admin channel down');
          }
        }),
      };

      const router = new OutputMessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender: failSender,
      });

      // Should not throw
      await router.route({ content: 'Test', level: MessageLevel.RESULT });

      // Both should have been attempted
      expect(failSender.sendText).toHaveBeenCalledTimes(2);
    });
  });
});

// ============================================================================
// Input MessageRouter Tests (cross-source routing)
// ============================================================================

describe('Input MessageRouter cross-source routing', () => {
  let handler: IAgentMessageHandler;

  beforeEach(() => {
    handler = {
      handleUserMessage: vi.fn().mockResolvedValue(undefined),
      handleSystemMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should route UserMessage to handleUserMessage', async () => {
    const router = new InputMessageRouter({ handler });

    const userMsg: UserMessage = {
      id: 'msg-1',
      source: 'user',
      payload: 'Hello from user',
      chatId: 'oc_chat',
      messageId: 'feishu-msg-1',
      createdAt: new Date().toISOString(),
    };

    await router.route(userMsg);

    expect(handler.handleUserMessage).toHaveBeenCalledWith(
      'oc_chat',
      'Hello from user',
      'feishu-msg-1',
      undefined,
      undefined,
      undefined
    );
    expect(handler.handleSystemMessage).not.toHaveBeenCalled();
  });

  it('should route SystemMessage to handleSystemMessage', async () => {
    const router = new InputMessageRouter({ handler });

    const sysMsg: SystemMessage = {
      id: 'msg-2',
      source: 'system',
      payload: 'Scheduled task prompt',
      chatId: 'oc_chat',
      trigger: 'scheduled',
      createdAt: new Date().toISOString(),
    };

    await router.route(sysMsg);

    expect(handler.handleSystemMessage).toHaveBeenCalledWith(
      'oc_chat',
      'Scheduled task prompt',
      'msg-2'
    );
    expect(handler.handleUserMessage).not.toHaveBeenCalled();
  });

  it('should handle mixed UserMessage and SystemMessage in sequence', async () => {
    const router = new InputMessageRouter({ handler });

    const userMsg: UserMessage = {
      id: 'msg-u1',
      source: 'user',
      payload: 'User query',
      chatId: 'oc_chat_1',
      messageId: 'fm-1',
      createdAt: new Date().toISOString(),
    };

    const sysMsg: SystemMessage = {
      id: 'msg-s1',
      source: 'system',
      payload: 'System task',
      chatId: 'oc_chat_2',
      trigger: 'signal',
      createdAt: new Date().toISOString(),
    };

    await router.route(userMsg);
    await router.route(sysMsg);

    expect(handler.handleUserMessage).toHaveBeenCalledTimes(1);
    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('should route messages to different chatIds independently', async () => {
    const router = new InputMessageRouter({ handler });

    const messages: UserMessage[] = [
      { id: 'm1', source: 'user', payload: 'Chat A', chatId: 'oc_A', messageId: 'f1', createdAt: '' },
      { id: 'm2', source: 'user', payload: 'Chat B', chatId: 'oc_B', messageId: 'f2', createdAt: '' },
      { id: 'm3', source: 'user', payload: 'Chat A again', chatId: 'oc_A', messageId: 'f3', createdAt: '' },
    ];

    for (const msg of messages) {
      await router.route(msg);
    }

    expect(handler.handleUserMessage).toHaveBeenCalledTimes(3);
    // Verify chatIds are routed correctly (order matters)
    expect(vi.mocked(handler.handleUserMessage)).toHaveBeenNthCalledWith(1, 'oc_A', 'Chat A', 'f1', undefined, undefined, undefined);
    expect(vi.mocked(handler.handleUserMessage)).toHaveBeenNthCalledWith(2, 'oc_B', 'Chat B', 'f2', undefined, undefined, undefined);
    expect(vi.mocked(handler.handleUserMessage)).toHaveBeenNthCalledWith(3, 'oc_A', 'Chat A again', 'f3', undefined, undefined, undefined);
  });
});

// ============================================================================
// createDefaultRouteConfig
// ============================================================================

describe('createDefaultRouteConfig', () => {
  it('should produce valid config with default user levels', () => {
    const config = createDefaultRouteConfig('oc_my_chat');

    expect(config.userChatId).toBe('oc_my_chat');
    expect(config.userMessageLevels).toEqual([...DEFAULT_USER_LEVELS]);
    expect(config.adminChatId).toBeUndefined();
  });
});
