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

  describe('isPrivateChat', () => {
    it('should return true for private chat IDs (ou_)', () => {
      expect(service.isPrivateChat('ou_abc123')).toBe(true);
      expect(service.isPrivateChat('ou_xyz789')).toBe(true);
    });

    it('should return false for group chat IDs (oc_)', () => {
      expect(service.isPrivateChat('oc_abc123')).toBe(false);
    });

    it('should return false for other IDs', () => {
      expect(service.isPrivateChat('some-random-id')).toBe(false);
    });
  });

  describe('isGroupChat', () => {
    it('should return true for group chat IDs (oc_)', () => {
      expect(service.isGroupChat('oc_abc123')).toBe(true);
      expect(service.isGroupChat('oc_xyz789')).toBe(true);
    });

    it('should return false for private chat IDs (ou_)', () => {
      expect(service.isGroupChat('ou_abc123')).toBe(false);
    });
  });

  describe('handleBotAddedToGroup', () => {
    it('should send welcome message to group', async () => {
      await service.handleBotAddedToGroup('oc_test123');

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith('oc_test123', '👋 Welcome!');
    });

    it('should not send message to non-group chat', async () => {
      await service.handleBotAddedToGroup('ou_test123');

      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('should handle send message error', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('Send failed'));

      // Should not throw
      await service.handleBotAddedToGroup('oc_test123');

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleFirstPrivateChat', () => {
    it('should send welcome message on first private chat', async () => {
      const result = await service.handleFirstPrivateChat('ou_user123');

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith('ou_user123', '👋 Welcome!');
    });

    it('should not send message on subsequent private chats', async () => {
      const result1 = await service.handleFirstPrivateChat('ou_user123');
      const result2 = await service.handleFirstPrivateChat('ou_user123');

      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('should not send message to non-private chat', async () => {
      const result = await service.handleFirstPrivateChat('oc_group123');

      expect(result).toBe(false);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('should track different users separately', async () => {
      const result1 = await service.handleFirstPrivateChat('ou_user1');
      const result2 = await service.handleFirstPrivateChat('ou_user2');

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    });

    it('should handle send message error', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('Send failed'));

      const result = await service.handleFirstPrivateChat('ou_user123');

      expect(result).toBe(false);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleP2PChatEntered', () => {
    it('should delegate to handleFirstPrivateChat', async () => {
      const result = await service.handleP2PChatEntered('ou_user123');

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getFirstTimeChatCount', () => {
    it('should return count of tracked first-time chats', async () => {
      expect(service.getFirstTimeChatCount()).toBe(0);

      await service.handleFirstPrivateChat('ou_user1');
      expect(service.getFirstTimeChatCount()).toBe(1);

      await service.handleFirstPrivateChat('ou_user2');
      expect(service.getFirstTimeChatCount()).toBe(2);

      // Same user again should not increase count
      await service.handleFirstPrivateChat('ou_user1');
      expect(service.getFirstTimeChatCount()).toBe(2);
    });
  });

  describe('clearFirstTimeChats', () => {
    it('should clear all tracked chats', async () => {
      await service.handleFirstPrivateChat('ou_user1');
      await service.handleFirstPrivateChat('ou_user2');

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
