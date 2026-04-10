/**
 * Tests for MessageRouter (packages/primary-node/src/messaging/message-router.ts)
 *
 * Covers:
 * - route(): message routing to admin/user chats
 * - getTargets(): target selection based on message level
 * - isUserVisible(): user level visibility check
 * - hasAdminChat(): admin chat configuration
 * - setUserLevels(): dynamic level updates
 * - setAdminChatId(): dynamic admin chat updates
 * - createDefaultRouteConfig(): factory function
 *
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessageRouter,
  createDefaultRouteConfig,
  type MessageRouterOptions,
} from './message-router.js';
import { MessageLevel, DEFAULT_USER_LEVELS, type IMessageSender, type MessageRouteConfig } from './types.js';

function createMockSender(): IMessageSender {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
  };
}

function createRouterOptions(
  overrides: Partial<MessageRouteConfig> = {}
): MessageRouterOptions {
  return {
    config: {
      userChatId: 'user-chat-1',
      adminChatId: 'admin-chat-1',
      userMessageLevels: [...DEFAULT_USER_LEVELS],
      ...overrides,
    },
    sender: createMockSender(),
  };
}

describe('MessageRouter', () => {
  describe('constructor', () => {
    it('should initialize with default user levels when none provided', () => {
      const options = createRouterOptions({
        userChatId: 'chat-1',
      });
      delete options.config.userMessageLevels;

      const router = new MessageRouter(options);
      // Default levels should make RESULT visible to user
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(true);
    });

    it('should use custom user levels when provided', () => {
      const options = createRouterOptions({
        userMessageLevels: [MessageLevel.ERROR],
      });

      const router = new MessageRouter(options);
      expect(router.isUserVisible(MessageLevel.ERROR)).toBe(true);
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(false);
    });
  });

  describe('getTargets', () => {
    it('should return admin chat for all levels', () => {
      const router = new MessageRouter(createRouterOptions());

      for (const level of [
        MessageLevel.DEBUG,
        MessageLevel.PROGRESS,
        MessageLevel.INFO,
        MessageLevel.RESULT,
        MessageLevel.ERROR,
      ]) {
        const targets = router.getTargets(level);
        expect(targets).toContain('admin-chat-1');
      }
    });

    it('should include user chat for user-visible levels', () => {
      const router = new MessageRouter(createRouterOptions());

      const targets = router.getTargets(MessageLevel.RESULT);
      expect(targets).toContain('user-chat-1');
      expect(targets).toContain('admin-chat-1');
    });

    it('should not include user chat for non-user-visible levels', () => {
      const router = new MessageRouter(createRouterOptions({
        userMessageLevels: [MessageLevel.RESULT],
      }));

      const targets = router.getTargets(MessageLevel.DEBUG);
      expect(targets).not.toContain('user-chat-1');
      expect(targets).toContain('admin-chat-1');
    });

    it('should avoid duplicate when admin and user chat are the same', () => {
      const router = new MessageRouter(createRouterOptions({
        adminChatId: 'same-chat',
        userChatId: 'same-chat',
      }));

      const targets = router.getTargets(MessageLevel.RESULT);
      // Should only appear once
      expect(targets.filter(id => id === 'same-chat')).toHaveLength(1);
    });

    it('should return empty when no admin or user chat configured', () => {
      const router = new MessageRouter({
        config: {
          userChatId: 'user-chat',
        },
        sender: createMockSender(),
      });

      // Non-visible level should have no targets (no admin chat)
      const targets = router.getTargets(MessageLevel.DEBUG);
      expect(targets).toHaveLength(0);
    });

    it('should return only admin chat when no user chat for level', () => {
      const router = new MessageRouter(createRouterOptions({
        userMessageLevels: [MessageLevel.ERROR],
      }));

      const targets = router.getTargets(MessageLevel.INFO);
      expect(targets).toEqual(['admin-chat-1']);
    });
  });

  describe('route', () => {
    it('should send to all targets', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'admin-chat',
          userChatId: 'user-chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      await router.route({
        content: 'Task completed',
        level: MessageLevel.RESULT,
      });

      expect(sender.sendText).toHaveBeenCalledTimes(2);
      expect(sender.sendText).toHaveBeenCalledWith('admin-chat', 'Task completed');
      expect(sender.sendText).toHaveBeenCalledWith('user-chat', 'Task completed');
    });

    it('should not send when no targets', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          userChatId: 'user-chat',
        },
        sender,
      });

      await router.route({
        content: 'Debug info',
        level: MessageLevel.DEBUG,
      });

      expect(sender.sendText).not.toHaveBeenCalled();
    });

    it('should continue sending to other targets on error', async () => {
      const sender = createMockSender();
      (sender.sendText as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Send failed'))
        .mockResolvedValueOnce(undefined);

      const router = new MessageRouter({
        config: {
          adminChatId: 'admin-chat',
          userChatId: 'user-chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      // Should not throw even if one send fails
      await router.route({
        content: 'Test',
        level: MessageLevel.RESULT,
      });

      // Both should have been attempted
      expect(sender.sendText).toHaveBeenCalledTimes(2);
    });

    it('should log debug info when no targets', async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const router = new MessageRouter({
        config: {
          userChatId: 'user-chat',
        },
        sender: createMockSender(),
        logger: mockLogger,
      });

      await router.route({
        content: 'Debug info',
        level: MessageLevel.DEBUG,
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('No targets'),
        expect.any(Object)
      );
    });
  });

  describe('setUserLevels', () => {
    it('should update user-visible levels', () => {
      const router = new MessageRouter(createRouterOptions());

      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(true);

      router.setUserLevels([MessageLevel.ERROR]);

      expect(router.isUserVisible(MessageLevel.ERROR)).toBe(true);
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(false);
    });

    it('should clear previous levels on update', () => {
      const router = new MessageRouter(createRouterOptions());

      router.setUserLevels([]);

      for (const level of Object.values(MessageLevel)) {
        expect(router.isUserVisible(level)).toBe(false);
      }
    });
  });

  describe('setAdminChatId', () => {
    it('should update admin chat ID', () => {
      const router = new MessageRouter(createRouterOptions());

      expect(router.hasAdminChat()).toBe(true);
      expect(router.getAdminChatId()).toBe('admin-chat-1');

      router.setAdminChatId('new-admin-chat');

      expect(router.getAdminChatId()).toBe('new-admin-chat');
    });

    it('should allow unsetting admin chat', () => {
      const router = new MessageRouter(createRouterOptions());

      router.setAdminChatId(undefined);

      expect(router.hasAdminChat()).toBe(false);
    });
  });

  describe('getUserChatId', () => {
    it('should return the configured user chat ID', () => {
      const router = new MessageRouter(createRouterOptions());
      expect(router.getUserChatId()).toBe('user-chat-1');
    });
  });
});

describe('createDefaultRouteConfig', () => {
  it('should create config with default values', () => {
    const config = createDefaultRouteConfig('test-chat-id');

    expect(config.userChatId).toBe('test-chat-id');
    expect(config.userMessageLevels).toEqual([...DEFAULT_USER_LEVELS]);
    expect(config.showTaskLifecycle).toEqual({
      showStart: false,
      showProgress: false,
      showComplete: true,
    });
    expect(config.errors).toEqual({
      showStack: false,
      showDetails: 'admin',
    });
  });

  it('should create different config for different chat IDs', () => {
    const config1 = createDefaultRouteConfig('chat-1');
    const config2 = createDefaultRouteConfig('chat-2');

    expect(config1.userChatId).toBe('chat-1');
    expect(config2.userChatId).toBe('chat-2');
  });
});
