/**
 * Tests for ChatOps utility functions.
 *
 * @see Issue #402
 * @see Issue #486 - Added removeMembers, getMembers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { createDiscussionChat, addMembers, removeMembers, getMembers, getBotChats } from './chat-ops.js';

// Mock lark client
const mockClient = {
  im: {
    chat: {
      create: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    chatMembers: {
      create: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
    },
  },
} as unknown as lark.Client;

// Mock logger from @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('ChatOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createDiscussionChat', () => {
    it('should create a group chat and return chat ID', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { chat_id: 'oc_new_chat_123' },
      });

      const chatId = await createDiscussionChat(mockClient, {
        topic: 'Test Discussion',
        members: ['ou_user_1', 'ou_user_2'],
      });

      expect(chatId).toBe('oc_new_chat_123');
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          name: 'Test Discussion',
          chat_mode: 'group',
          chat_type: 'group',
          user_id_list: ['ou_user_1', 'ou_user_2'],
        },
        params: {
          user_id_type: 'open_id',
        },
      });
    });

    it('should create a group chat without members (using creatorId)', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { chat_id: 'oc_new_chat_456' },
      });

      const chatId = await createDiscussionChat(
        mockClient,
        { topic: 'Test Group' },
        'ou_creator_1'
      );

      expect(chatId).toBe('oc_new_chat_456');
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          name: 'Test Group',
          chat_mode: 'group',
          chat_type: 'group',
          user_id_list: ['ou_creator_1'],
        },
        params: {
          user_id_type: 'open_id',
        },
      });
    });

    it('should create a group chat with auto-generated name', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: { chat_id: 'oc_new_chat_789' },
      });

      const chatId = await createDiscussionChat(mockClient, {}, 'ou_creator_1');

      expect(chatId).toBe('oc_new_chat_789');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            chat_mode: 'group',
            chat_type: 'group',
            user_id_list: ['ou_creator_1'],
          }),
        })
      );
      // Verify the name contains date pattern
      const [[callArgs]] = mockCreate.mock.calls as [[{ data: { name: string } }]];
      expect(callArgs.data.name).toMatch(/讨论组 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    });

    it('should throw error when chat_id is not returned', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({
        data: {},
      });

      await expect(
        createDiscussionChat(mockClient, {
          topic: 'Test Discussion',
          members: ['ou_user_1'],
        })
      ).rejects.toThrow('Failed to get chat_id from response');
    });

    it('should throw and log on API error', async () => {
      const mockCreate = mockClient.im.chat.create as ReturnType<typeof vi.fn>;
      mockCreate.mockRejectedValue(new Error('API error'));

      await expect(
        createDiscussionChat(mockClient, {
          topic: 'Test Discussion',
          members: ['ou_user_1'],
        })
      ).rejects.toThrow('API error');
    });
  });

  describe('addMembers', () => {
    it('should add members to a chat successfully', async () => {
      const mockCreate = mockClient.im.chatMembers.create as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValue({});

      await addMembers(mockClient, 'oc_chat_123', ['ou_user_1', 'ou_user_2']);

      expect(mockCreate).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: { id_list: ['ou_user_1', 'ou_user_2'] },
        params: { member_id_type: 'open_id' },
      });
    });

    it('should throw on add members error', async () => {
      const mockCreate = mockClient.im.chatMembers.create as ReturnType<typeof vi.fn>;
      mockCreate.mockRejectedValue(new Error('User not found'));

      await expect(
        addMembers(mockClient, 'oc_chat_123', ['ou_invalid_user'])
      ).rejects.toThrow('User not found');
    });
  });

  describe('removeMembers', () => {
    it('should remove members from a chat successfully', async () => {
      const mockDelete = mockClient.im.chatMembers.delete as ReturnType<typeof vi.fn>;
      mockDelete.mockResolvedValue({});

      await removeMembers(mockClient, 'oc_chat_123', ['ou_user_1']);

      expect(mockDelete).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        data: { id_list: ['ou_user_1'] },
        params: { member_id_type: 'open_id' },
      });
    });

    it('should throw on remove members error', async () => {
      const mockDelete = mockClient.im.chatMembers.delete as ReturnType<typeof vi.fn>;
      mockDelete.mockRejectedValue(new Error('Permission denied'));

      await expect(
        removeMembers(mockClient, 'oc_chat_123', ['ou_user_1'])
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('getMembers', () => {
    it('should get members from a chat successfully', async () => {
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

      const members = await getMembers(mockClient, 'oc_chat_123');

      expect(members).toEqual(['ou_user_1', 'ou_user_2', 'ou_user_3']);
      expect(mockGet).toHaveBeenCalledWith({
        path: { chat_id: 'oc_chat_123' },
        params: { member_id_type: 'open_id' },
      });
    });

    it('should return empty array when no members', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        data: { items: [] },
      });

      const members = await getMembers(mockClient, 'oc_chat_123');

      expect(members).toEqual([]);
    });

    it('should return empty array when data is undefined', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({});

      const members = await getMembers(mockClient, 'oc_chat_123');

      expect(members).toEqual([]);
    });

    it('should throw on get members error', async () => {
      const mockGet = mockClient.im.chatMembers.get as ReturnType<typeof vi.fn>;
      mockGet.mockRejectedValue(new Error('Chat not found'));

      await expect(getMembers(mockClient, 'oc_invalid_chat')).rejects.toThrow('Chat not found');
    });
  });

  describe('getBotChats', () => {
    it('should get all bot chats successfully', async () => {
      const mockList = mockClient.im.chat.list as ReturnType<typeof vi.fn>;
      mockList.mockResolvedValue({
        data: {
          items: [
            { chat_id: 'oc_chat_1', name: 'Group 1' },
            { chat_id: 'oc_chat_2', name: 'Group 2' },
          ],
        },
      });

      const chats = await getBotChats(mockClient);

      expect(mockList).toHaveBeenCalledWith({
        params: {
          page_size: 50,
          page_token: undefined,
        },
      });
      expect(chats).toHaveLength(2);
      expect(chats[0]).toEqual({ chatId: 'oc_chat_1', name: 'Group 1' });
      expect(chats[1]).toEqual({ chatId: 'oc_chat_2', name: 'Group 2' });
    });

    it('should handle pagination', async () => {
      const mockList = mockClient.im.chat.list as ReturnType<typeof vi.fn>;
      mockList
        .mockResolvedValueOnce({
          data: {
            items: [{ chat_id: 'oc_chat_1', name: 'Group 1' }],
            page_token: 'next_page',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ chat_id: 'oc_chat_2', name: 'Group 2' }],
          },
        });

      const chats = await getBotChats(mockClient);

      expect(mockList).toHaveBeenCalledTimes(2);
      expect(chats).toHaveLength(2);
    });

    it('should return empty array when no chats', async () => {
      const mockList = mockClient.im.chat.list as ReturnType<typeof vi.fn>;
      mockList.mockResolvedValue({
        data: {
          items: [],
        },
      });

      const chats = await getBotChats(mockClient);

      expect(chats).toEqual([]);
    });

    it('should throw on API error', async () => {
      const mockList = mockClient.im.chat.list as ReturnType<typeof vi.fn>;
      mockList.mockRejectedValue(new Error('API error'));

      await expect(getBotChats(mockClient)).rejects.toThrow('API error');
    });
  });
});
