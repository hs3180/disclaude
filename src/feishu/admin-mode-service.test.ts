/**
 * Tests for AdminModeService.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { AdminModeService } from './admin-mode-service.js';
import { UserStateStore } from './user-state-store.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace-admin-service',
  },
}));

// Mock lark client
const mockClient = {
  im: {
    chat: {
      create: vi.fn(),
    },
  },
};

describe('AdminModeService', () => {
  let service: AdminModeService;
  let store: UserStateStore;
  const testDir = '/tmp/test-workspace-admin-service';

  beforeEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await fs.mkdir(testDir, { recursive: true });

    // Reset mocks
    vi.clearAllMocks();

    store = new UserStateStore();
    await store.init();

    service = new AdminModeService({
      client: mockClient as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').Client>,
      userStateStore: store,
      autoCreateLogChat: false,
    });
    await service.init();
  });

  afterEach(async () => {
    store.clear();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('handleMessage', () => {
    describe('enable admin mode', () => {
      it('should enable admin mode when user says "开启管理员"', async () => {
        const result = await service.handleMessage('user-1', 'chat-1', '开启管理员');

        expect(result.handled).toBe(true);
        expect(result.action).toBe('enabled');
        expect(service.isAdminModeEnabled('user-1')).toBe(true);
      });

      it('should return confirmed when admin mode is already enabled', async () => {
        await service.handleMessage('user-1', 'chat-1', '开启管理员');
        const result = await service.handleMessage('user-1', 'chat-1', '开启管理员');

        expect(result.handled).toBe(true);
        expect(result.action).toBe('confirmed');
        expect(result.response).toContain('已经开启');
      });
    });

    describe('disable admin mode', () => {
      it('should disable admin mode when user says "关闭管理员"', async () => {
        await service.handleMessage('user-1', 'chat-1', '开启管理员');
        const result = await service.handleMessage('user-1', 'chat-1', '关闭管理员');

        expect(result.handled).toBe(true);
        expect(result.action).toBe('disabled');
        expect(service.isAdminModeEnabled('user-1')).toBe(false);
      });

      it('should return confirmed when admin mode is already disabled', async () => {
        const result = await service.handleMessage('user-1', 'chat-1', '关闭管理员');

        expect(result.handled).toBe(true);
        expect(result.action).toBe('confirmed');
        expect(result.response).toContain('已经关闭');
      });
    });

    describe('non-admin intent', () => {
      it('should return handled=false for non-admin messages', async () => {
        const result = await service.handleMessage('user-1', 'chat-1', 'hello world');

        expect(result.handled).toBe(false);
      });

      it('should return handled=false for questions', async () => {
        const result = await service.handleMessage('user-1', 'chat-1', '如何使用这个功能？');

        expect(result.handled).toBe(false);
      });
    });
  });

  describe('autoCreateLogChat', () => {
    it('should not create log chat when autoCreateLogChat is false', async () => {
      const result = await service.handleMessage('user-1', 'chat-1', '开启管理员');

      expect(result.handled).toBe(true);
      expect(result.logChatId).toBeUndefined();
      expect(mockClient.im.chat.create).not.toHaveBeenCalled();
    });

    it('should create log chat when autoCreateLogChat is true', async () => {
      mockClient.im.chat.create.mockResolvedValueOnce({
        data: { chat_id: 'log-chat-1' },
      });

      const serviceWithAutoCreate = new AdminModeService({
        client: mockClient as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').Client>,
        userStateStore: store,
        autoCreateLogChat: true,
      });
      await serviceWithAutoCreate.init();

      const result = await serviceWithAutoCreate.handleMessage('user-1', 'chat-1', '开启管理员');

      expect(result.handled).toBe(true);
      expect(result.logChatId).toBe('log-chat-1');
      expect(mockClient.im.chat.create).toHaveBeenCalled();
    });

    it('should handle log chat creation failure', async () => {
      mockClient.im.chat.create.mockRejectedValueOnce(new Error('API error'));

      const serviceWithAutoCreate = new AdminModeService({
        client: mockClient as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').Client>,
        userStateStore: store,
        autoCreateLogChat: true,
      });
      await serviceWithAutoCreate.init();

      const result = await serviceWithAutoCreate.handleMessage('user-1', 'chat-1', '开启管理员');

      expect(result.handled).toBe(true);
      expect(result.action).toBe('rejected');
      expect(result.response).toContain('失败');
    });
  });

  describe('isAdminModeEnabled', () => {
    it('should return false for non-existent user', () => {
      expect(service.isAdminModeEnabled('non-existent')).toBe(false);
    });

    it('should return true after enabling admin mode', async () => {
      await service.handleMessage('user-1', 'chat-1', '开启管理员');
      expect(service.isAdminModeEnabled('user-1')).toBe(true);
    });
  });

  describe('getLogChatId', () => {
    it('should return undefined when admin mode is disabled', () => {
      expect(service.getLogChatId('user-1')).toBeUndefined();
    });

    it('should return log chat ID when set', async () => {
      await store.setAdminMode('user-1', true, 'log-chat-1');
      expect(service.getLogChatId('user-1')).toBe('log-chat-1');
    });
  });

  describe('getAdminUsers', () => {
    it('should return empty array when no admin users', () => {
      expect(service.getAdminUsers()).toHaveLength(0);
    });

    it('should return all admin users', async () => {
      await service.handleMessage('user-1', 'chat-1', '开启管理员');
      await service.handleMessage('user-2', 'chat-2', '开启管理员');

      const adminUsers = service.getAdminUsers();
      expect(adminUsers).toHaveLength(2);
    });
  });
});
