/**
 * Tests for ChatManager.
 *
 * Tests the group chat management functionality for Feishu platform:
 * - Creating group chats
 * - Dissolving group chats
 * - Adding/removing members
 * - Getting chat info
 * - Getting chat members
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatManager } from './chat-manager.js';
import type { Logger } from 'pino';

// Mock lark client
const mockClient = {
  im: {
    chat: {
      create: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
    },
    chatMembers: {
      create: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
    },
  },
};

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => mockClient),
}));

describe('ChatManager', () => {
  let chatManager: ChatManager;

  beforeEach(() => {
    vi.clearAllMocks();

    chatManager = new ChatManager({
      client: mockClient as any,
      logger: mockLogger as unknown as Logger,
    });
  });

  describe('createGroup', () => {
    it('should create a group chat successfully', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { chat_id: 'oc_new_chat_123' },
      });

      const chatId = await chatManager.createGroup({
        name: 'Test Group',
        ownerId: 'ou_owner_123',
        initialMembers: ['ou_member_456'],
      });

      expect(chatId).toBe('oc_new_chat_123');
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          name: 'Test Group',
          chat_mode: 'group',
          chat_type: 'group',
          user_id_list: expect.arrayContaining(['ou_owner_123', 'ou_member_456']),
          owner_id: 'ou_owner_123',
        },
        params: {
          user_id_type: 'open_id',
        },
      });
    });

    it('should include owner in member list even if not in initialMembers', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { chat_id: 'oc_new_chat_456' },
      });

      await chatManager.createGroup({
        name: 'Test Group',
        ownerId: 'ou_owner_789',
        initialMembers: ['ou_member_1', 'ou_member_2'],
      });

      const callData = mockCreate.mock.calls[0][0].data;
      expect(callData.user_id_list).toContain('ou_owner_789');
      expect(callData.user_id_list).toContain('ou_member_1');
      expect(callData.user_id_list).toContain('ou_member_2');
    });

    it('should work with no initial members (only owner)', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { chat_id: 'oc_new_chat_789' },
      });

      const chatId = await chatManager.createGroup({
        name: 'Owner Only Group',
        ownerId: 'ou_owner_123',
      });

      expect(chatId).toBe('oc_new_chat_789');
      const callData = mockCreate.mock.calls[0][0].data;
      expect(callData.user_id_list).toEqual(['ou_owner_123']);
    });

    it('should throw error when chat_id is not returned', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: {},
      });

      await expect(
        chatManager.createGroup({
          name: 'Test Group',
          ownerId: 'ou_owner_123',
        })
      ).rejects.toThrow('Failed to get chat_id from response');
    });

    it('should throw and log on API error', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      const apiError = new Error('API error');
      mockCreate.mockRejectedValue(apiError);

      await expect(
        chatManager.createGroup({
          name: 'Test Group',
          ownerId: 'ou_owner_123',
        })
      ).rejects.toThrow('API error');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('dissolveGroup', () => {
    it('should dissolve a group chat successfully', async () => {
      const mockDelete = mockClient.im.chat.delete as ReturnType<typeof vi.fn>;
      mockDelete.mockResolvedValue({});

      await chatManager.dissolveGroup('oc_chat_123');

      expect(mockDelete).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { chatId: 'oc_chat_123' },
        'Group chat dissolved'
      );
    });

    it('should throw and log on dissolve error', async () => {
      const mockDelete = mockClient.im.chat.delete as ReturnType<typeof vi.fn>;
      const apiError = new Error('Permission denied');
      mockDelete.mockRejectedValue(apiError);

      await expect(chatManager.dissolveGroup('oc_chat_123')).rejects.toThrow(
        'Permission denied'
      );

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('addMembers', () => {
    it('should add members to a group chat successfully', async () => {
      const mockCreate = mockClient.im.chatMembers.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({});

      await chatManager.addMembers('oc_chat_123', ['ou_user_1', 'ou_user_2']);

      expect(mockCreate).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: {
          id_list: ['ou_user_1', 'ou_user_2'],
        },
        params: {
          member_id_type: 'open_id',
        },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { chatId: 'oc_chat_123', memberCount: 2 },
        'Members added to group chat'
      );
    });

    it('should throw and log on add members error', async () => {
      const mockCreate = mockClient.im.chatMembers.create as ReturnType<typeof vi.fn>;
      const apiError = new Error('User not found');
      mockCreate.mockRejectedValue(apiError);

      await expect(
        chatManager.addMembers('oc_chat_123', ['ou_invalid_user'])
      ).rejects.toThrow('User not found');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('removeMembers', () => {
    it('should remove members from a group chat successfully', async () => {
      const mockDelete = mockClient.im.chatMembers.delete as ReturnType<typeof vi.fn>;
      mockDelete.mockResolvedValue({});

      await chatManager.removeMembers('oc_chat_123', ['ou_user_1']);

      expect(mockDelete).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: {
          id_list: ['ou_user_1'],
        },
        params: {
          member_id_type: 'open_id',
        },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { chatId: 'oc_chat_123', memberCount: 1 },
        'Members removed from group chat'
      );
    });

    it('should throw and log on remove members error', async () => {
      const mockDelete = mockClient.im.chatMembers.delete as ReturnType<typeof vi.fn>;
      const apiError = new Error('Cannot remove owner');
      mockDelete.mockRejectedValue(apiError);

      await expect(
        chatManager.removeMembers('oc_chat_123', ['ou_owner'])
      ).rejects.toThrow('Cannot remove owner');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('getChatInfo', () => {
    it('should get chat info successfully', async () => {
      const mockGet = mockClient.im.chat.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: {
          name: 'Test Group',
          owner_id: 'ou_owner_123',
          user_count: '5',
          description: 'A test group',
        },
      });

      const chatInfo = await chatManager.getChatInfo('oc_chat_123');

      expect(chatInfo).toEqual({
        chatId: 'oc_chat_123',
        name: 'Test Group',
        ownerId: 'ou_owner_123',
        memberCount: 5,
        description: 'A test group',
      });
      expect(mockGet).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        params: {
          user_id_type: 'open_id',
        },
      });
    });

    it('should handle missing optional fields', async () => {
      const mockGet = mockClient.im.chat.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: {
          // name and description missing
        },
      });

      const chatInfo = await chatManager.getChatInfo('oc_chat_456');

      expect(chatInfo).toEqual({
        chatId: 'oc_chat_456',
        name: '',
        ownerId: '',
        memberCount: 0,
        description: undefined,
      });
    });

    it('should parse user_count string to number', async () => {
      const mockGet = mockClient.im.chat.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: {
          name: 'Test Group',
          user_count: '10',
        },
      });

      const chatInfo = await chatManager.getChatInfo('oc_chat_123');

      expect(chatInfo.memberCount).toBe(10);
    });

    it('should throw error when response data is missing', async () => {
      const mockGet = mockClient.im.chat.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({});

      await expect(chatManager.getChatInfo('oc_chat_123')).rejects.toThrow(
        'Failed to get chat info from response'
      );
    });

    it('should throw and log on get chat info error', async () => {
      const mockGet = mockClient.im.chat.get as ReturnType<typeof vi.fn>;
      const apiError = new Error('Chat not found');
      mockGet.mockRejectedValue(apiError);

      await expect(chatManager.getChatInfo('oc_invalid_chat')).rejects.toThrow(
        'Chat not found'
      );

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('getMembers', () => {
    it('should get chat members successfully', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: {
          items: [
            { member_id: 'ou_user_1' },
            { member_id: 'ou_user_2' },
            { member_id: 'ou_user_3' },
          ],
        },
      });

      const members = await chatManager.getMembers('oc_chat_123');

      expect(members).toEqual(['ou_user_1', 'ou_user_2', 'ou_user_3']);
      expect(mockGet).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        params: {
          member_id_type: 'open_id',
          page_size: 100,
        },
      });
    });

    it('should return empty array when no members', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: { items: [] },
      });

      const members = await chatManager.getMembers('oc_chat_123');

      expect(members).toEqual([]);
    });

    it('should filter out undefined member_ids', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: {
          items: [
            { member_id: 'ou_user_1' },
            { member_id: undefined },
            { member_id: 'ou_user_2' },
          ],
        },
      });

      const members = await chatManager.getMembers('oc_chat_123');

      expect(members).toEqual(['ou_user_1', 'ou_user_2']);
    });

    it('should throw and log on get members error', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      const apiError = new Error('Access denied');
      mockGet.mockRejectedValue(apiError);

      await expect(chatManager.getMembers('oc_chat_123')).rejects.toThrow('Access denied');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('updateChatInfo', () => {
    it('should update chat name successfully', async () => {
      const mockUpdate = mockClient.im.chat.update as ReturnType<typeof vi.fn>;
      mockUpdate.mockResolvedValue({});

      await chatManager.updateChatInfo('oc_chat_123', { name: 'New Group Name' });

      expect(mockUpdate).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: {
          name: 'New Group Name',
          description: undefined,
        },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { chatId: 'oc_chat_123', updates: { name: 'New Group Name' } },
        'Chat info updated'
      );
    });

    it('should update chat description successfully', async () => {
      const mockUpdate = mockClient.im.chat.update as ReturnType<typeof vi.fn>;
      mockUpdate.mockResolvedValue({});

      await chatManager.updateChatInfo('oc_chat_123', {
        description: 'New description',
      });

      expect(mockUpdate).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: {
          name: undefined,
          description: 'New description',
        },
      });
    });

    it('should update both name and description', async () => {
      const mockUpdate = mockClient.im.chat.update as ReturnType<typeof vi.fn>;
      mockUpdate.mockResolvedValue({});

      await chatManager.updateChatInfo('oc_chat_123', {
        name: 'New Name',
        description: 'New Description',
      });

      expect(mockUpdate).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: {
          name: 'New Name',
          description: 'New Description',
        },
      });
    });

    it('should throw and log on update error', async () => {
      const mockUpdate = mockClient.im.chat.update as ReturnType<typeof vi.fn>;
      const apiError = new Error('Update failed');
      mockUpdate.mockRejectedValue(apiError);

      await expect(
        chatManager.updateChatInfo('oc_chat_123', { name: 'New Name' })
      ).rejects.toThrow('Update failed');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
