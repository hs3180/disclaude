/**
 * Tests for Welcome Handler.
 *
 * Tests welcome message handling for new chats and group joins.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WelcomeHandler } from './welcome-handler.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe('WelcomeHandler', () => {
  let handler: WelcomeHandler;
  let mockWelcomeService: any;
  let mockIsRunning: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWelcomeService = {
      handleP2PChatEntered: vi.fn().mockResolvedValue('sent'),
      handleBotAddedToGroup: vi.fn().mockResolvedValue(undefined),
      handleUserJoinedGroup: vi.fn().mockResolvedValue(undefined),
      generateWelcomeMessage: vi.fn(),
      sendMessage: vi.fn(),
      firstTimePrivateChats: new Set(),
      isPrivateChat: vi.fn(),
    } as any;
    mockIsRunning = vi.fn().mockReturnValue(true);
    handler = new WelcomeHandler('cli_app_123', mockIsRunning);
    handler.setWelcomeService(mockWelcomeService);
  });

  describe('handleP2PChatEntered', () => {
    it('should send welcome message when user enters P2P chat', async () => {
      const data = {
        event: {
          user: { open_id: 'ou_user_123' },
        },
      };

      await handler.handleP2PChatEntered(data as any);

      expect(mockWelcomeService.handleP2PChatEntered).toHaveBeenCalledWith('ou_user_123');
    });

    it('should skip when not running', async () => {
      mockIsRunning.mockReturnValue(false);

      await handler.handleP2PChatEntered({
        event: { user: { open_id: 'ou_user_123' } },
      } as any);

      expect(mockWelcomeService.handleP2PChatEntered).not.toHaveBeenCalled();
    });

    it('should skip when welcome service is not set', async () => {
      const handlerNoService = new WelcomeHandler('cli_app_123', mockIsRunning);

      await handlerNoService.handleP2PChatEntered({
        event: { user: { open_id: 'ou_user_123' } },
      } as any);

      // Should not throw
    });

    it('should skip when event is missing user info', async () => {
      await handler.handleP2PChatEntered({ event: {} } as any);
      await handler.handleP2PChatEntered({ event: { user: {} } } as any);

      expect(mockWelcomeService.handleP2PChatEntered).not.toHaveBeenCalled();
    });

    it('should skip when event is missing open_id', async () => {
      await handler.handleP2PChatEntered({
        event: { user: { open_id: undefined } },
      } as any);

      expect(mockWelcomeService.handleP2PChatEntered).not.toHaveBeenCalled();
    });
  });

  describe('handleChatMemberAdded', () => {
    it('should send welcome when bot is added to group', async () => {
      const data = {
        event: {
          chat_id: 'oc_group_123',
          members: [
            { member_id_type: 'app_id', member_id: 'cli_app_123' },
          ],
        },
      };

      await handler.handleChatMemberAdded(data as any);

      expect(mockWelcomeService.handleBotAddedToGroup).toHaveBeenCalledWith('oc_group_123');
    });

    it('should send help when user joins group that has bot', async () => {
      const data = {
        event: {
          chat_id: 'oc_group_123',
          members: [
            { member_id_type: 'open_id', member_id: 'ou_user_456' },
          ],
        },
      };

      await handler.handleChatMemberAdded(data as any);

      expect(mockWelcomeService.handleUserJoinedGroup).toHaveBeenCalledWith('oc_group_123', ['ou_user_456']);
    });

    it('should skip non-group chats (P2P)', async () => {
      const data = {
        event: {
          chat_id: 'ou_p2p_chat',
          members: [
            { member_id_type: 'open_id', member_id: 'ou_user_456' },
          ],
        },
      };

      await handler.handleChatMemberAdded(data as any);

      expect(mockWelcomeService.handleBotAddedToGroup).not.toHaveBeenCalled();
      expect(mockWelcomeService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should skip when not running', async () => {
      mockIsRunning.mockReturnValue(false);

      await handler.handleChatMemberAdded({
        event: {
          chat_id: 'oc_group_123',
          members: [{ member_id_type: 'app_id', member_id: 'cli_app_123' }],
        },
      } as any);

      expect(mockWelcomeService.handleBotAddedToGroup).not.toHaveBeenCalled();
    });

    it('should skip when welcome service is not set', async () => {
      const handlerNoService = new WelcomeHandler('cli_app_123', mockIsRunning);

      await handlerNoService.handleChatMemberAdded({
        event: {
          chat_id: 'oc_group_123',
          members: [{ member_id_type: 'app_id', member_id: 'cli_app_123' }],
        },
      } as any);
    });

    it('should skip when event has no chat_id', async () => {
      await handler.handleChatMemberAdded({
        event: {
          members: [{ member_id_type: 'open_id', member_id: 'ou_user_456' }],
        },
      } as any);

      expect(mockWelcomeService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should skip when event has no members', async () => {
      await handler.handleChatMemberAdded({
        event: {
          chat_id: 'oc_group_123',
          members: [],
        },
      } as any);

      expect(mockWelcomeService.handleBotAddedToGroup).not.toHaveBeenCalled();
      expect(mockWelcomeService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should handle multiple user members joining', async () => {
      const data = {
        event: {
          chat_id: 'oc_group_123',
          members: [
            { member_id_type: 'open_id', member_id: 'ou_user_1' },
            { member_id_type: 'open_id', member_id: 'ou_user_2' },
            { member_id_type: 'open_id', member_id: 'ou_user_3' },
          ],
        },
      };

      await handler.handleChatMemberAdded(data as any);

      expect(mockWelcomeService.handleUserJoinedGroup).toHaveBeenCalledWith(
        'oc_group_123',
        ['ou_user_1', 'ou_user_2', 'ou_user_3']
      );
    });

    it('should send bot welcome even when both bot and users are added', async () => {
      const data = {
        event: {
          chat_id: 'oc_group_123',
          members: [
            { member_id_type: 'app_id', member_id: 'cli_app_123' },
            { member_id_type: 'open_id', member_id: 'ou_user_1' },
          ],
        },
      };

      await handler.handleChatMemberAdded(data as any);

      expect(mockWelcomeService.handleBotAddedToGroup).toHaveBeenCalledWith('oc_group_123');
      expect(mockWelcomeService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should not trigger for different app_id', async () => {
      const data = {
        event: {
          chat_id: 'oc_group_123',
          members: [
            { member_id_type: 'app_id', member_id: 'cli_different_app' },
          ],
        },
      };

      await handler.handleChatMemberAdded(data as any);

      // Different app_id means it's a user, not the bot
      expect(mockWelcomeService.handleUserJoinedGroup).toHaveBeenCalledWith('oc_group_123', ['cli_different_app']);
      expect(mockWelcomeService.handleBotAddedToGroup).not.toHaveBeenCalled();
    });
  });
});
