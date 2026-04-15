/**
 * Tests for WelcomeHandler.
 *
 * Tests P2P chat entered and chat member added event handling.
 * Issue #1617: Improves unit test coverage for welcome-handler.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WelcomeService } from '../../platforms/feishu/welcome-service.js';
import type {
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
} from '@disclaude/core';

// Mock @disclaude/core logger
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

import { WelcomeHandler } from './welcome-handler.js';

function createMockWelcomeService(): WelcomeService {
  return {
    handleP2PChatEntered: vi.fn().mockResolvedValue('sent'),
    handleBotAddedToGroup: vi.fn().mockResolvedValue(undefined),
    handleUserJoinedGroup: vi.fn().mockResolvedValue(undefined),
  } as unknown as WelcomeService;
}

describe('WelcomeHandler', () => {
  let handler: WelcomeHandler;
  let mockService: WelcomeService;
  let isRunning: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    isRunning = vi.fn().mockReturnValue(true);
    handler = new WelcomeHandler('test_app_id', isRunning);
    mockService = createMockWelcomeService();
    handler.setWelcomeService(mockService);
  });

  describe('constructor', () => {
    it('should create instance with appId and isRunning', () => {
      const h = new WelcomeHandler('my_app', () => true);
      expect(h).toBeDefined();
    });
  });

  describe('setWelcomeService', () => {
    it('should set the welcome service and enable event handling', async () => {
      const h = new WelcomeHandler('app', () => true);
      const svc = createMockWelcomeService();
      h.setWelcomeService(svc);

      await h.handleP2PChatEntered({
        event: { user: { open_id: 'ou_test_svc' }, timestamp: '123' },
      });

      expect(svc.handleP2PChatEntered).toHaveBeenCalledWith('ou_test_svc');
    });
  });

  describe('handleP2PChatEntered', () => {
    it('should call welcomeService.handleP2PChatEntered with user open_id', async () => {
      const data: FeishuP2PChatEnteredEventData = {
        event: {
          user: { open_id: 'ou_user123' },
          timestamp: '1234567890',
        },
      };

      await handler.handleP2PChatEntered(data);

      expect(mockService.handleP2PChatEntered).toHaveBeenCalledWith('ou_user123');
    });

    it('should skip when not running', async () => {
      isRunning.mockReturnValue(false);

      const data: FeishuP2PChatEnteredEventData = {
        event: { user: { open_id: 'ou_user123' }, timestamp: '1234567890' },
      };

      await handler.handleP2PChatEntered(data);

      expect(mockService.handleP2PChatEntered).not.toHaveBeenCalled();
    });

    it('should skip when no welcomeService is set', async () => {
      const handlerNoService = new WelcomeHandler('app', () => true);

      const data: FeishuP2PChatEnteredEventData = {
        event: { user: { open_id: 'ou_user123' }, timestamp: '1234567890' },
      };

      // Should not throw
      await handlerNoService.handleP2PChatEntered(data);
    });

    it('should skip when event has no user info', async () => {
      const data: FeishuP2PChatEnteredEventData = {
        event: {},
      } as FeishuP2PChatEnteredEventData;

      await handler.handleP2PChatEntered(data);

      expect(mockService.handleP2PChatEntered).not.toHaveBeenCalled();
    });

    it('should skip when event is undefined', async () => {
      const data: FeishuP2PChatEnteredEventData = {};

      await handler.handleP2PChatEntered(data);

      expect(mockService.handleP2PChatEntered).not.toHaveBeenCalled();
    });

    it('should skip when user open_id is empty', async () => {
      const data: FeishuP2PChatEnteredEventData = {
        event: {
          user: { open_id: '' },
          timestamp: '1234567890',
        },
      };

      // Empty string is falsy, but open_id is a string — handler checks existence not truthiness
      // Actually the code checks `!event?.user?.open_id` which is truthy check
      // So empty string would cause early return
      await handler.handleP2PChatEntered(data);

      expect(mockService.handleP2PChatEntered).not.toHaveBeenCalled();
    });
  });

  describe('handleChatMemberAdded', () => {
    it('should call handleBotAddedToGroup when bot is among added members', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_group123',
          timestamp: '1234567890',
          members: [
            { member_id_type: 'app_id', member_id: 'test_app_id' },
          ],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleBotAddedToGroup).toHaveBeenCalledWith('oc_group123');
      expect(mockService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should call handleUserJoinedGroup when users join existing group', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_group456',
          timestamp: '1234567890',
          members: [
            { member_id_type: 'open_id', member_id: 'ou_user1' },
            { member_id_type: 'open_id', member_id: 'ou_user2' },
          ],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleUserJoinedGroup).toHaveBeenCalledWith(
        'oc_group456',
        ['ou_user1', 'ou_user2'],
      );
      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
    });

    it('should prefer bot added handler over user joined when both present', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_group789',
          timestamp: '1234567890',
          members: [
            { member_id_type: 'app_id', member_id: 'test_app_id' },
            { member_id_type: 'open_id', member_id: 'ou_user1' },
          ],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      // Bot added takes priority
      expect(mockService.handleBotAddedToGroup).toHaveBeenCalledWith('oc_group789');
      expect(mockService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should skip when not running', async () => {
      isRunning.mockReturnValue(false);

      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_group',
          timestamp: '1234567890',
          members: [{ member_id_type: 'app_id', member_id: 'test_app_id' }],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
    });

    it('should skip when no welcomeService is set', async () => {
      const handlerNoService = new WelcomeHandler('app', () => true);

      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_group',
          timestamp: '1234567890',
          members: [{ member_id_type: 'app_id', member_id: 'test_app_id' }],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      // Should not throw
      await handlerNoService.handleChatMemberAdded(data);
    });

    it('should skip when event has no chat_id', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: '',
          timestamp: '1234567890',
          members: [{ member_id_type: 'app_id', member_id: 'test_app_id' }],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
    });

    it('should skip when event has no members', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_group',
          timestamp: '1234567890',
          members: [],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
    });

    it('should skip when event is undefined', async () => {
      const data: FeishuChatMemberAddedEventData = {};

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
      expect(mockService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should skip when chat_id is for private chat (starts with ou_)', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'ou_private123',
          timestamp: '1234567890',
          members: [{ member_id_type: 'app_id', member_id: 'test_app_id' }],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
      expect(mockService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should not call any handler when only the bot is added to a non-group chat', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'ou_private456',
          timestamp: '1234567890',
          members: [
            { member_id_type: 'app_id', member_id: 'test_app_id' },
            { member_id_type: 'open_id', member_id: 'ou_user1' },
          ],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      // All member additions to non-group chats are skipped
      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
      expect(mockService.handleUserJoinedGroup).not.toHaveBeenCalled();
    });

    it('should correctly identify bot by app_id and matching member_id', async () => {
      const data: FeishuChatMemberAddedEventData = {
        event: {
          chat_id: 'oc_test',
          timestamp: '1234567890',
          members: [
            { member_id_type: 'open_id', member_id: 'test_app_id' },  // Different member_id_type
            { member_id_type: 'app_id', member_id: 'different_app' },  // Different app_id
            { member_id_type: 'open_id', member_id: 'ou_user1' },
          ],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      // Bot not in members (wrong member_id_type or wrong member_id), so user join handler
      expect(mockService.handleBotAddedToGroup).not.toHaveBeenCalled();
      expect(mockService.handleUserJoinedGroup).toHaveBeenCalledWith(
        'oc_test',
        ['test_app_id', 'different_app', 'ou_user1'],  // All filtered as non-bot users
      );
    });

    it('should handle members array with undefined entries gracefully', async () => {
      const data = {
        event: {
          chat_id: 'oc_group',
          timestamp: '1234567890',
          members: [
            { member_id_type: 'open_id', member_id: 'ou_user1' },
            undefined as unknown as { member_id_type: string; member_id: string },
            { member_id_type: 'open_id', member_id: 'ou_user2' },
          ],
          operator: { operator_id_type: 'open_id', operator_id: 'ou_admin' },
        },
      };

      await handler.handleChatMemberAdded(data);

      expect(mockService.handleUserJoinedGroup).toHaveBeenCalledWith(
        'oc_group',
        ['ou_user1', 'ou_user2'],
      );
    });
  });
});
