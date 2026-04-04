/**
 * Tests for Message Router.
 *
 * Tests level-based message routing to admin and user chats.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouter, createDefaultRouteConfig } from './message-router.js';
import { MessageLevel, DEFAULT_USER_LEVELS } from './types.js';

const mockSender = {
  sendText: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
};

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('MessageRouter', () => {
  let router: MessageRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new MessageRouter({
      config: {
        adminChatId: 'admin-chat',
        userChatId: 'user-chat',
        userMessageLevels: [MessageLevel.RESULT, MessageLevel.ERROR],
      },
      sender: mockSender,
      logger: mockLogger,
    });
  });

  describe('getTargets', () => {
    it('should return admin chat for all levels', () => {
      expect(router.getTargets(MessageLevel.DEBUG)).toContain('admin-chat');
      expect(router.getTargets(MessageLevel.PROGRESS)).toContain('admin-chat');
      expect(router.getTargets(MessageLevel.RESULT)).toContain('admin-chat');
      expect(router.getTargets(MessageLevel.ERROR)).toContain('admin-chat');
    });

    it('should return user chat only for user-visible levels', () => {
      // RESULT is user-visible
      const resultTargets = router.getTargets(MessageLevel.RESULT);
      expect(resultTargets).toContain('user-chat');

      // DEBUG is not user-visible
      const debugTargets = router.getTargets(MessageLevel.DEBUG);
      expect(debugTargets).not.toContain('user-chat');
    });

    it('should not duplicate when admin and user chat are the same', () => {
      const sameChatRouter = new MessageRouter({
        config: {
          adminChatId: 'same-chat',
          userChatId: 'same-chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender: mockSender,
      });

      const targets = sameChatRouter.getTargets(MessageLevel.RESULT);
      expect(targets).toHaveLength(1);
      expect(targets).toEqual(['same-chat']);
    });

    it('should return empty when no admin chat configured and level not user-visible', () => {
      const noAdminRouter = new MessageRouter({
        config: {
          userChatId: 'user-chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender: mockSender,
      });

      const targets = noAdminRouter.getTargets(MessageLevel.DEBUG);
      expect(targets).toEqual([]);
    });
  });

  describe('route', () => {
    it('should send message to admin chat', async () => {
      await router.route({
        level: MessageLevel.DEBUG,
        content: 'Debug message',
      });

      expect(mockSender.sendText).toHaveBeenCalledWith('admin-chat', 'Debug message');
    });

    it('should send to both admin and user for user-visible levels', async () => {
      await router.route({
        level: MessageLevel.RESULT,
        content: 'Result message',
      });

      expect(mockSender.sendText).toHaveBeenCalledWith('admin-chat', 'Result message');
      expect(mockSender.sendText).toHaveBeenCalledWith('user-chat', 'Result message');
    });

    it('should not send when no targets', async () => {
      const noAdminRouter = new MessageRouter({
        config: {
          userChatId: 'user-chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender: mockSender,
      });

      await noAdminRouter.route({
        level: MessageLevel.DEBUG,
        content: 'Debug message',
      });

      expect(mockSender.sendText).not.toHaveBeenCalled();
    });

    it('should continue sending to other targets when one fails', async () => {
      mockSender.sendText
        .mockRejectedValueOnce(new Error('Admin chat failed'))
        .mockResolvedValueOnce(undefined);

      await router.route({
        level: MessageLevel.RESULT,
        content: 'Test message',
      });

      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle send errors gracefully', async () => {
      mockSender.sendText.mockRejectedValue(new Error('Send failed'));

      await router.route({
        level: MessageLevel.DEBUG,
        content: 'Error test',
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('isUserVisible', () => {
    it('should return true for configured user-visible levels', () => {
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(true);
      expect(router.isUserVisible(MessageLevel.ERROR)).toBe(true);
    });

    it('should return false for non-user-visible levels', () => {
      expect(router.isUserVisible(MessageLevel.DEBUG)).toBe(false);
      expect(router.isUserVisible(MessageLevel.PROGRESS)).toBe(false);
    });
  });

  describe('hasAdminChat', () => {
    it('should return true when admin chat is configured', () => {
      expect(router.hasAdminChat()).toBe(true);
    });

    it('should return false when admin chat is not configured', () => {
      const noAdminRouter = new MessageRouter({
        config: { userChatId: 'user-chat' },
        sender: mockSender,
      });
      expect(noAdminRouter.hasAdminChat()).toBe(false);
    });
  });

  describe('getAdminChatId', () => {
    it('should return admin chat ID', () => {
      expect(router.getAdminChatId()).toBe('admin-chat');
    });

    it('should return undefined when not configured', () => {
      const noAdminRouter = new MessageRouter({
        config: { userChatId: 'user-chat' },
        sender: mockSender,
      });
      expect(noAdminRouter.getAdminChatId()).toBeUndefined();
    });
  });

  describe('getUserChatId', () => {
    it('should return user chat ID', () => {
      expect(router.getUserChatId()).toBe('user-chat');
    });
  });

  describe('setUserLevels', () => {
    it('should update user-visible levels', () => {
      router.setUserLevels([MessageLevel.DEBUG, MessageLevel.PROGRESS]);
      expect(router.isUserVisible(MessageLevel.DEBUG)).toBe(true);
      expect(router.isUserVisible(MessageLevel.PROGRESS)).toBe(true);
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(false);
    });

    it('should handle empty levels array', () => {
      router.setUserLevels([]);
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(false);
      expect(router.isUserVisible(MessageLevel.DEBUG)).toBe(false);
    });
  });

  describe('setAdminChatId', () => {
    it('should update admin chat ID', () => {
      router.setAdminChatId('new-admin-chat');
      expect(router.getAdminChatId()).toBe('new-admin-chat');
    });

    it('should allow removing admin chat', () => {
      router.setAdminChatId(undefined);
      expect(router.hasAdminChat()).toBe(false);
    });
  });
});

describe('createDefaultRouteConfig', () => {
  it('should create config with user chat ID', () => {
    const config = createDefaultRouteConfig('user-123');
    expect(config.userChatId).toBe('user-123');
  });

  it('should include default user message levels', () => {
    const config = createDefaultRouteConfig('user-123');
    expect(config.userMessageLevels).toEqual([...DEFAULT_USER_LEVELS]);
  });

  it('should set showTaskLifecycle defaults', () => {
    const config = createDefaultRouteConfig('user-123');
    expect(config.showTaskLifecycle?.showStart).toBe(false);
    expect(config.showTaskLifecycle?.showProgress).toBe(false);
    expect(config.showTaskLifecycle?.showComplete).toBe(true);
  });

  it('should set error defaults', () => {
    const config = createDefaultRouteConfig('user-123');
    expect(config.errors?.showStack).toBe(false);
    expect(config.errors?.showDetails).toBe('admin');
  });
});
