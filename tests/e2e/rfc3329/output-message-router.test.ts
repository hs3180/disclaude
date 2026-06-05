/**
 * Integration test: Output MessageRouter cross-channel routing.
 *
 * Tests the level-based output message routing:
 *   MessageRouter.route(RoutedMessage) → sendText(adminChat, ...) and/or sendText(userChat, ...)
 *
 * Verifies that:
 * - Admin chat receives all message levels
 * - User chat receives only configured levels (RESULT, ERROR, NOTICE, IMPORTANT)
 * - DEBUG/PROGRESS messages go to admin only
 * - Broadcast: same message sent to both admin and user when level is user-visible
 * - Dynamic level updates immediately affect routing behavior
 *
 * @see Issue #3662 — category 4
 * @see Issue #266 — Level-based message routing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageRouter,
  type MessageRouterOptions,
  type IMessageSender,
  type RoutedMessage,
  MessageLevel,
  DEFAULT_USER_LEVELS,
} from '@disclaude/primary-node';

/**
 * Create a mock sender that captures all sendText calls.
 */
function createMockSender(): {
  sender: IMessageSender;
  calls: Array<{ chatId: string; content: string }>;
} {
  const calls: Array<{ chatId: string; content: string }> = [];

  return {
    calls,
    sender: {
      sendText: vi.fn().mockImplementation(async (chatId: string, content: string) => {
        calls.push({ chatId, content });
      }),
    },
  };
}

const ADMIN_CHAT = 'oc_admin_chat';
const USER_CHAT = 'oc_user_chat';

describe('Output MessageRouter cross-channel routing (RFC #3329)', () => {
  let router: MessageRouter;
  let mockSender: ReturnType<typeof createMockSender>;

  beforeEach(() => {
    mockSender = createMockSender();
  });

  it('should send RESULT messages to both admin and user chat', async () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    const message: RoutedMessage = {
      content: 'Task completed successfully',
      level: MessageLevel.RESULT,
    };

    await router.route(message);

    expect(mockSender.calls).toHaveLength(2);
    expect(mockSender.calls.map((c) => c.chatId)).toEqual(
      expect.arrayContaining([ADMIN_CHAT, USER_CHAT])
    );
    expect(mockSender.calls.every((c) => c.content === 'Task completed successfully')).toBe(true);
  });

  it('should send DEBUG messages to admin chat only', async () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    const message: RoutedMessage = {
      content: 'Tool invocation details',
      level: MessageLevel.DEBUG,
    };

    await router.route(message);

    expect(mockSender.calls).toHaveLength(1);
    expect(mockSender.calls[0].chatId).toBe(ADMIN_CHAT);
  });

  it('should send PROGRESS messages to admin chat only', async () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    const message: RoutedMessage = {
      content: 'Processing step 3 of 10',
      level: MessageLevel.PROGRESS,
    };

    await router.route(message);

    expect(mockSender.calls).toHaveLength(1);
    expect(mockSender.calls[0].chatId).toBe(ADMIN_CHAT);
  });

  it('should send ERROR messages to both admin and user chat', async () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    const message: RoutedMessage = {
      content: 'Something went wrong',
      level: MessageLevel.ERROR,
    };

    await router.route(message);

    expect(mockSender.calls).toHaveLength(2);
    expect(mockSender.calls.map((c) => c.chatId)).toEqual(
      expect.arrayContaining([ADMIN_CHAT, USER_CHAT])
    );
  });

  it('should send NOTICE messages to both admin and user chat', async () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    const message: RoutedMessage = {
      content: 'System notification',
      level: MessageLevel.NOTICE,
    };

    await router.route(message);

    expect(mockSender.calls).toHaveLength(2);
    expect(mockSender.calls.map((c) => c.chatId)).toEqual(
      expect.arrayContaining([ADMIN_CHAT, USER_CHAT])
    );
  });

  it('should route to admin only for non-user-visible levels', () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    // INFO is not in DEFAULT_USER_LEVELS
    const targets = router.getTargets(MessageLevel.INFO);
    expect(targets).toEqual([ADMIN_CHAT]);
  });

  it('should handle mixed success/failure in broadcast without losing messages', async () => {
    const failSender: IMessageSender = {
      sendText: vi.fn().mockImplementation(async (chatId: string) => {
        if (chatId === ADMIN_CHAT) {
          throw new Error('Admin chat failed');
        }
        // User chat succeeds
      }),
    };

    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: failSender,
    });

    // Should not throw even when one target fails
    const message: RoutedMessage = {
      content: 'Broadcast test',
      level: MessageLevel.RESULT,
    };

    await expect(router.route(message)).resolves.toBeUndefined();
  });

  it('should immediately reflect dynamic level updates in routing', async () => {
    router = new MessageRouter({
      config: {
        adminChatId: ADMIN_CHAT,
        userChatId: USER_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    // Initially: DEBUG goes to admin only
    const targetsBefore = router.getTargets(MessageLevel.DEBUG);
    expect(targetsBefore).toEqual([ADMIN_CHAT]);

    // Update levels to include DEBUG for user
    router.setUserLevels([MessageLevel.DEBUG, ...DEFAULT_USER_LEVELS]);

    // Now DEBUG should go to both admin and user
    const targetsAfter = router.getTargets(MessageLevel.DEBUG);
    expect(targetsAfter).toEqual(expect.arrayContaining([ADMIN_CHAT, USER_CHAT]));
    expect(targetsAfter).toHaveLength(2);
  });

  it('should deduplicate when admin and user chat are the same', async () => {
    const SAME_CHAT = 'oc_same_chat';

    router = new MessageRouter({
      config: {
        adminChatId: SAME_CHAT,
        userChatId: SAME_CHAT,
        userMessageLevels: [...DEFAULT_USER_LEVELS],
      },
      sender: mockSender.sender,
    });

    // RESULT is user-visible, but since admin === user, should send only once
    const message: RoutedMessage = {
      content: 'Deduplicated message',
      level: MessageLevel.RESULT,
    };

    await router.route(message);

    expect(mockSender.calls).toHaveLength(1);
    expect(mockSender.calls[0].chatId).toBe(SAME_CHAT);
  });
});
