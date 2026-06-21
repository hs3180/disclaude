/**
 * Tests for WelcomeService.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WelcomeService,
  initWelcomeService,
  getWelcomeService,
  resetWelcomeService,
} from './welcome-service.js';

describe('WelcomeService', () => {
  let service: WelcomeService;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessageMock = vi.fn().mockResolvedValue(undefined);
    service = new WelcomeService({
      generateWelcomeMessage: () => '👋 Welcome!',
      sendMessage: sendMessageMock,
    });
    resetWelcomeService();
  });

  afterEach(() => {
    resetWelcomeService();
  });

  // Note: isGroupChat/isPrivateChat classification is covered by
  // chat-type-utils.test.ts (it classifies by chat_type, not chat ID prefix).

  describe('handleBotAddedToGroup', () => {
    it('should send welcome message to group', async () => {
      await service.handleBotAddedToGroup('oc_test123', 'group');

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith('oc_test123', '👋 Welcome!');
    });

    it('should not send message to non-group chat type', async () => {
      await service.handleBotAddedToGroup('ou_test123', 'p2p');

      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('should handle send message error', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('Send failed'));

      // Should not throw
      await service.handleBotAddedToGroup('oc_test123', 'group');

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleUserJoinedGroup', () => {
    it('should send help message to group when users join', async () => {
      await service.handleUserJoinedGroup('oc_test123', 'group', ['ou_user1', 'ou_user2']);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith('oc_test123', '👋 Welcome!');
    });

    it('should use custom help message if provided', async () => {
      const customService = new WelcomeService({
        generateWelcomeMessage: () => '👋 Welcome!',
        generateHelpMessage: () => '📖 Help info for new users',
        sendMessage: sendMessageMock,
      });

      await customService.handleUserJoinedGroup('oc_test123', 'group', ['ou_user1']);

      expect(sendMessageMock).toHaveBeenCalledWith('oc_test123', '📖 Help info for new users');
    });

    it('should not send message to non-group chat type', async () => {
      await service.handleUserJoinedGroup('ou_test123', 'p2p', ['ou_user1']);

      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('should handle send message error', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('Send failed'));

      // Should not throw
      await service.handleUserJoinedGroup('oc_test123', 'group', ['ou_user1']);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('should work without user IDs parameter', async () => {
      await service.handleUserJoinedGroup('oc_test123', 'group');

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith('oc_test123', '👋 Welcome!');
    });
  });

  describe('handleFirstPrivateChat', () => {
    it('should send welcome message on first private chat', async () => {
      const result = await service.handleFirstPrivateChat('ou_user123', 'p2p');

      expect(result).toBe('sent');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith('ou_user123', '👋 Welcome!');
    });

    it('should not send message on subsequent private chats', async () => {
      const result1 = await service.handleFirstPrivateChat('ou_user123', 'p2p');
      const result2 = await service.handleFirstPrivateChat('ou_user123', 'p2p');

      expect(result1).toBe('sent');
      expect(result2).toBe('already_sent');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('should not send message to non-private chat type', async () => {
      const result = await service.handleFirstPrivateChat('oc_group123', 'group');

      expect(result).toBe('skipped');
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('should track different users separately', async () => {
      const result1 = await service.handleFirstPrivateChat('ou_user1', 'p2p');
      const result2 = await service.handleFirstPrivateChat('ou_user2', 'p2p');

      expect(result1).toBe('sent');
      expect(result2).toBe('sent');
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    });

    it('should handle send message error and return failed', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('Send failed'));

      const result = await service.handleFirstPrivateChat('ou_user123', 'p2p');

      expect(result).toBe('failed');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('should allow retry after failed send', async () => {
      // Issue #1357: After failure, chatId should be removed from tracked set
      sendMessageMock.mockRejectedValueOnce(new Error('Send failed'));

      const result1 = await service.handleFirstPrivateChat('ou_user123', 'p2p');
      expect(result1).toBe('failed');

      // Next call should retry since it was removed from the set
      sendMessageMock.mockResolvedValueOnce(undefined);
      const result2 = await service.handleFirstPrivateChat('ou_user123', 'p2p');
      expect(result2).toBe('sent');

      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleP2PChatEntered', () => {
    it('should delegate to handleFirstPrivateChat', async () => {
      const result = await service.handleP2PChatEntered('ou_user123', 'p2p');

      expect(result).toBe('sent');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getFirstTimeChatCount', () => {
    it('should return count of tracked first-time chats', async () => {
      expect(service.getFirstTimeChatCount()).toBe(0);

      await service.handleFirstPrivateChat('ou_user1', 'p2p');
      expect(service.getFirstTimeChatCount()).toBe(1);

      await service.handleFirstPrivateChat('ou_user2', 'p2p');
      expect(service.getFirstTimeChatCount()).toBe(2);

      // Same user again should not increase count
      await service.handleFirstPrivateChat('ou_user1', 'p2p');
      expect(service.getFirstTimeChatCount()).toBe(2);
    });
  });

  describe('clearFirstTimeChats', () => {
    it('should clear all tracked chats', async () => {
      await service.handleFirstPrivateChat('ou_user1', 'p2p');
      await service.handleFirstPrivateChat('ou_user2', 'p2p');

      expect(service.getFirstTimeChatCount()).toBe(2);

      service.clearFirstTimeChats();

      expect(service.getFirstTimeChatCount()).toBe(0);
    });
  });
});

describe('Global WelcomeService', () => {
  beforeEach(() => {
    resetWelcomeService();
  });

  afterEach(() => {
    resetWelcomeService();
  });

  describe('initWelcomeService', () => {
    it('should initialize and return global service', () => {
      const service = initWelcomeService({
        generateWelcomeMessage: () => 'Welcome',
        sendMessage: vi.fn(),
      });

      expect(service).toBeInstanceOf(WelcomeService);
      expect(getWelcomeService()).toBe(service);
    });
  });

  describe('getWelcomeService', () => {
    it('should return undefined before initialization', () => {
      expect(getWelcomeService()).toBeUndefined();
    });

    it('should return the initialized service', () => {
      const service = initWelcomeService({
        generateWelcomeMessage: () => 'Welcome',
        sendMessage: vi.fn(),
      });

      expect(getWelcomeService()).toBe(service);
    });
  });

  describe('resetWelcomeService', () => {
    it('should clear the global service', () => {
      initWelcomeService({
        generateWelcomeMessage: () => 'Welcome',
        sendMessage: vi.fn(),
      });

      expect(getWelcomeService()).toBeDefined();

      resetWelcomeService();

      expect(getWelcomeService()).toBeUndefined();
    });
  });
});
