/**
 * Tests for FeishuChatManager.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FeishuChatManager,
  resetFeishuChatManager,
} from './feishu-chat-manager.js';
import {
  resetAdminStatusManager,
} from '../../messaging/admin-status-manager.js';

// Mock lark client
const mockChatCreate = vi.fn();
const mockChatGet = vi.fn();
const mockChatMembersCreate = vi.fn();
const mockChatMembersDelete = vi.fn();

const mockClient = {
  im: {
    chat: {
      create: mockChatCreate,
      get: mockChatGet,
    },
    chatMembers: {
      create: mockChatMembersCreate,
      delete: mockChatMembersDelete,
    },
  },
} as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').Client>;

// Mock admin status manager
vi.mock('../../messaging/admin-status-manager.js', () => ({
  getAdminStatusManager: vi.fn(() => ({
    getLogChatId: vi.fn(() => undefined),
    setLogChatId: vi.fn(),
  })),
  resetAdminStatusManager: vi.fn(),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('FeishuChatManager', () => {
  let manager: FeishuChatManager;

  beforeEach(() => {
    vi.clearAllMocks();
    resetFeishuChatManager();

    manager = new FeishuChatManager({
      client: mockClient,
      botName: 'TestBot',
    });
  });

  describe('getOrCreateLogChat', () => {
    it('should create a new chat when no existing chat', async () => {
      mockChatCreate.mockResolvedValueOnce({
        data: { chat_id: 'new_chat_123' },
      });
      mockChatMembersCreate.mockResolvedValueOnce({});

      const result = await manager.getOrCreateLogChat('user_123', 'Test User');

      expect(result.chatId).toBe('new_chat_123');
      expect(result.created).toBe(true);
      expect(mockChatCreate).toHaveBeenCalled();
    });

    it('should reuse existing chat when available', async () => {
      // Mock existing chat
      vi.mocked(await import('../../messaging/admin-status-manager.js')).getAdminStatusManager
        .mockReturnValueOnce({
          getLogChatId: vi.fn(() => 'existing_chat_456'),
          setLogChatId: vi.fn(),
          initialize: vi.fn(),
          enableAdmin: vi.fn(),
          disableAdmin: vi.fn(),
          getAdminStatus: vi.fn(),
          isAdminEnabled: vi.fn(),
          getAllAdmins: vi.fn(() => []),
          removeAdmin: vi.fn(),
          clearAll: vi.fn(),
        } as unknown as import('../../messaging/admin-status-manager.js').AdminStatusManager);

      mockChatGet.mockResolvedValueOnce({ data: { chat_id: 'existing_chat_456' } });

      const newManager = new FeishuChatManager({
        client: mockClient,
        botName: 'TestBot',
      });

      const result = await newManager.getOrCreateLogChat('user_123');

      expect(result.chatId).toBe('existing_chat_456');
      expect(result.created).toBe(false);
    });

    it('should name chat with user name', async () => {
      mockChatCreate.mockResolvedValueOnce({
        data: { chat_id: 'new_chat_123' },
      });
      mockChatMembersCreate.mockResolvedValueOnce({});

      await manager.getOrCreateLogChat('user_123', 'John');

      const createCall = mockChatCreate.mock.calls[0][0];
      expect(createCall.data.name).toBe('TestBot 日志 - John');
    });

    it('should name chat without user name', async () => {
      mockChatCreate.mockResolvedValueOnce({
        data: { chat_id: 'new_chat_123' },
      });
      mockChatMembersCreate.mockResolvedValueOnce({});

      await manager.getOrCreateLogChat('user_123');

      const createCall = mockChatCreate.mock.calls[0][0];
      expect(createCall.data.name).toBe('TestBot 日志');
    });

    it('should throw when chat creation fails', async () => {
      mockChatCreate.mockResolvedValueOnce({ data: {} });

      await expect(manager.getOrCreateLogChat('user_123')).rejects.toThrow(
        'Failed to create log chat'
      );
    });
  });

  describe('addMember', () => {
    it('should add member to chat', async () => {
      mockChatMembersCreate.mockResolvedValueOnce({});

      const result = await manager.addMember('chat_123', 'user_456');

      expect(result).toBe(true);
      expect(mockChatMembersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { chat_id: 'chat_123' },
          data: { member_id_list: ['user_456'] },
        })
      );
    });

    it('should return true if user already in chat', async () => {
      mockChatMembersCreate.mockRejectedValueOnce({
        code: 230001,
        message: 'User already in chat',
      });

      const result = await manager.addMember('chat_123', 'user_456');

      expect(result).toBe(true);
    });

    it('should return false on other errors', async () => {
      mockChatMembersCreate.mockRejectedValueOnce(new Error('API error'));

      const result = await manager.addMember('chat_123', 'user_456');

      expect(result).toBe(false);
    });
  });

  describe('removeMember', () => {
    it('should remove member from chat', async () => {
      mockChatMembersDelete.mockResolvedValueOnce({});

      const result = await manager.removeMember('chat_123', 'user_456');

      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      mockChatMembersDelete.mockRejectedValueOnce(new Error('API error'));

      const result = await manager.removeMember('chat_123', 'user_456');

      expect(result).toBe(false);
    });
  });

  describe('chatExists', () => {
    it('should return true when chat exists', async () => {
      mockChatGet.mockResolvedValueOnce({ data: { chat_id: 'chat_123' } });

      const result = await manager.chatExists('chat_123');

      expect(result).toBe(true);
    });

    it('should return false when chat not found', async () => {
      mockChatGet.mockRejectedValueOnce({ code: 230001 });

      const result = await manager.chatExists('chat_123');

      expect(result).toBe(false);
    });

    it('should return true on other errors (assume exists)', async () => {
      mockChatGet.mockRejectedValueOnce(new Error('Network error'));

      const result = await manager.chatExists('chat_123');

      expect(result).toBe(true);
    });
  });
});
