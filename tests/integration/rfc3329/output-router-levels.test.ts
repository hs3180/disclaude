/**
 * Integration tests for Output MessageRouter cross-channel routing (RFC #3329).
 *
 * Verifies level-based message routing:
 * - Admin chat receives all messages (progress, debug, result, error)
 * - User chat receives only user-visible messages (filtered by level)
 * - Broadcast messages reach all configured channels
 * - Dynamic level updates affect routing behavior
 * - Duplicate prevention when admin and user chat are the same
 *
 * Issue #3662: Integration tests for RFC #3329 (Area 4)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessageRouter,
  createDefaultRouteConfig,
} from '../../../packages/primary-node/src/messaging/message-router.js';
import {
  MessageLevel,
  DEFAULT_USER_LEVELS,
  type IMessageSender,
  type RoutedMessage,
} from '../../../packages/core/src/types/messaging.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockSender(): IMessageSender & {
  calls: Array<{ chatId: string; content: string }>;
} {
  const calls: Array<{ chatId: string; content: string }> = [];
  return {
    sendText: vi.fn().mockImplementation(async (chatId: string, content: string) => {
      calls.push({ chatId, content });
    }),
    calls,
  };
}

function createRoutedMessage(level: MessageLevel, content: string): RoutedMessage {
  return { content, level };
}

// ============================================================================
// Integration: Admin chat receives all levels
// ============================================================================

describe('RFC #3329 Integration: Output MessageRouter cross-channel routing', () => {
  describe('Admin receives all message levels', () => {
    it('should send all message levels to admin chat', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      const allLevels = [
        MessageLevel.DEBUG,
        MessageLevel.PROGRESS,
        MessageLevel.INFO,
        MessageLevel.NOTICE,
        MessageLevel.IMPORTANT,
        MessageLevel.RESULT,
        MessageLevel.ERROR,
      ];

      for (const level of allLevels) {
        await router.route(createRoutedMessage(level, `Message at ${level}`));
      }

      // Admin should receive all 7 messages
      const adminCalls = sender.calls.filter((c) => c.chatId === 'oc_admin');
      expect(adminCalls).toHaveLength(allLevels.length);
    });
  });

  describe('User chat receives filtered messages', () => {
    it('should only send user-visible levels to user chat', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [MessageLevel.RESULT, MessageLevel.ERROR, MessageLevel.IMPORTANT],
        },
        sender,
      });

      // Send a non-user-visible level
      await router.route(createRoutedMessage(MessageLevel.DEBUG, 'Debug info'));
      expect(sender.calls.filter((c) => c.chatId === 'oc_user')).toHaveLength(0);
      expect(sender.calls.filter((c) => c.chatId === 'oc_admin')).toHaveLength(1);

      // Send a user-visible level
      sender.calls.length = 0;
      await router.route(createRoutedMessage(MessageLevel.RESULT, 'Task result'));
      const userCalls = sender.calls.filter((c) => c.chatId === 'oc_user');
      const adminCalls = sender.calls.filter((c) => c.chatId === 'oc_admin');
      expect(userCalls).toHaveLength(1);
      expect(adminCalls).toHaveLength(1);
      expect(userCalls[0].content).toBe('Task result');
    });

    it('should use DEFAULT_USER_LEVELS when no custom levels set', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
        },
        sender,
      });

      // Verify default levels are applied
      for (const level of DEFAULT_USER_LEVELS) {
        expect(router.isUserVisible(level)).toBe(true);
      }
    });
  });

  describe('Cross-channel routing with distinct admin and user chats', () => {
    it('should route result to both admin and user chats', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin_chat',
          userChatId: 'oc_user_chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.RESULT, '✅ Task completed'));

      expect(sender.calls).toHaveLength(2);
      const chatIds = sender.calls.map((c) => c.chatId);
      expect(chatIds).toContain('oc_admin_chat');
      expect(chatIds).toContain('oc_user_chat');
    });

    it('should route debug only to admin chat', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin_chat',
          userChatId: 'oc_user_chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.DEBUG, 'Tool: Read file.ts'));

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].chatId).toBe('oc_admin_chat');
    });

    it('should route progress only to admin chat by default', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin_chat',
          userChatId: 'oc_user_chat',
          userMessageLevels: [...DEFAULT_USER_LEVELS],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.PROGRESS, 'Processing... 50%'));

      // Progress is not in DEFAULT_USER_LEVELS, so only admin gets it
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].chatId).toBe('oc_admin_chat');
    });

    it('should route error to both admin and user (if error is user-visible)', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin_chat',
          userChatId: 'oc_user_chat',
          userMessageLevels: [MessageLevel.RESULT, MessageLevel.ERROR],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.ERROR, '❌ Task failed'));

      expect(sender.calls).toHaveLength(2);
    });
  });

  describe('Same chatId for admin and user', () => {
    it('should send message only once when admin and user chat are the same', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_same_chat',
          userChatId: 'oc_same_chat',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.RESULT, 'Result message'));

      // Should only send once, not twice
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].chatId).toBe('oc_same_chat');
    });
  });

  describe('Dynamic level updates', () => {
    it('should update routing when user levels change', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      // Initially, progress goes only to admin
      await router.route(createRoutedMessage(MessageLevel.PROGRESS, 'Progress 1'));
      expect(sender.calls.filter((c) => c.chatId === 'oc_user')).toHaveLength(0);

      // Update to include progress
      router.setUserLevels([MessageLevel.RESULT, MessageLevel.PROGRESS]);
      sender.calls.length = 0;

      // Now progress goes to both admin and user
      await router.route(createRoutedMessage(MessageLevel.PROGRESS, 'Progress 2'));
      expect(sender.calls.filter((c) => c.chatId === 'oc_user')).toHaveLength(1);
    });

    it('should clear all user routing when levels are emptied', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [MessageLevel.RESULT, MessageLevel.ERROR],
        },
        sender,
      });

      // Clear all user levels
      router.setUserLevels([]);

      // Even RESULT should not go to user
      await router.route(createRoutedMessage(MessageLevel.RESULT, 'Result'));
      expect(sender.calls.filter((c) => c.chatId === 'oc_user')).toHaveLength(0);
      expect(sender.calls.filter((c) => c.chatId === 'oc_admin')).toHaveLength(1);
    });
  });

  describe('No admin chat configured', () => {
    it('should route user-visible messages only to user chat', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          userChatId: 'oc_user_only',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.RESULT, 'Result'));
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].chatId).toBe('oc_user_only');
    });

    it('should not route non-user-visible messages when no admin', async () => {
      const sender = createMockSender();
      const router = new MessageRouter({
        config: {
          userChatId: 'oc_user_only',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      await router.route(createRoutedMessage(MessageLevel.DEBUG, 'Debug'));
      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('Error resilience', () => {
    it('should continue routing to remaining targets if one fails', async () => {
      const sender = createMockSender();
      let callCount = 0;
      (sender.sendText as ReturnType<typeof vi.fn>).mockImplementation(
        async (chatId: string) => {
          callCount++;
          if (chatId === 'oc_admin') {
            throw new Error('Admin channel unavailable');
          }
        },
      );

      const router = new MessageRouter({
        config: {
          adminChatId: 'oc_admin',
          userChatId: 'oc_user',
          userMessageLevels: [MessageLevel.RESULT],
        },
        sender,
      });

      // Should not throw
      await router.route(createRoutedMessage(MessageLevel.RESULT, 'Result'));

      // Both targets should have been attempted
      expect(callCount).toBe(2);
    });
  });

  describe('createDefaultRouteConfig integration', () => {
    it('should produce a working router with default config', async () => {
      const sender = createMockSender();
      const config = createDefaultRouteConfig('oc_user_chat');
      config.adminChatId = 'oc_admin_chat';

      const router = new MessageRouter({ config, sender });

      // RESULT should be user-visible with defaults
      await router.route(createRoutedMessage(MessageLevel.RESULT, 'Done'));
      expect(sender.calls.some((c) => c.chatId === 'oc_user_chat')).toBe(true);

      // DEBUG should be admin-only
      sender.calls.length = 0;
      await router.route(createRoutedMessage(MessageLevel.DEBUG, 'Debug info'));
      expect(sender.calls.every((c) => c.chatId === 'oc_admin_chat')).toBe(true);
    });
  });
});
