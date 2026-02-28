/**
 * ChatManager - Feishu Group Chat Management Service.
 *
 * This module implements the ChatManager service as defined in Issue #402:
 * - Create group chats
 * - Dissolve group chats
 * - Add members to chats
 * - Get chat information
 *
 * @module feishu/chat-manager
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';

/**
 * ChatManager configuration.
 */
export interface ChatManagerConfig {
  /** Feishu API client */
  client: lark.Client;
  /** Logger instance */
  logger: Logger;
}

/**
 * Options for creating a group chat.
 */
export interface CreateGroupOptions {
  /** Group chat name */
  name: string;
  /** Owner user ID (open_id format) */
  ownerId: string;
  /** Initial member user IDs (open_id format) */
  initialMembers?: string[];
}

/**
 * Chat information.
 */
export interface ChatInfo {
  /** Chat ID */
  chatId: string;
  /** Chat name */
  name: string;
  /** Owner user ID */
  ownerId: string;
  /** Member count */
  memberCount: number;
  /** Chat description */
  description?: string;
}

/**
 * ChatManager - Manages Feishu group chats.
 *
 * Provides methods for creating, managing, and querying group chats.
 */
export class ChatManager {
  private client: lark.Client;
  private logger: Logger;

  constructor(config: ChatManagerConfig) {
    this.client = config.client;
    this.logger = config.logger;
  }

  /**
   * Create a new group chat.
   *
   * @param options - Group creation options
   * @returns The created chat ID
   */
  async createGroup(options: CreateGroupOptions): Promise<string> {
    const { name, ownerId, initialMembers = [] } = options;

    try {
      // Ensure owner is in the member list
      const members = new Set(initialMembers);
      members.add(ownerId);

      const response = await this.client.im.chat.create({
        data: {
          name,
          chat_mode: 'group',
          chat_type: 'group',
          user_id_list: Array.from(members),
          owner_id: ownerId,
        },
        params: {
          user_id_type: 'open_id',
        },
      });

      const chatId = response?.data?.chat_id;
      if (!chatId) {
        throw new Error('Failed to get chat_id from response');
      }

      this.logger.info({ chatId, name, ownerId, memberCount: members.size }, 'Group chat created');
      return chatId;
    } catch (error) {
      this.logger.error({ err: error, name, ownerId }, 'Failed to create group chat');
      throw error;
    }
  }

  /**
   * Dissolve (delete) a group chat.
   *
   * Note: This requires the bot to be the chat owner or have admin permissions.
   *
   * @param chatId - The chat ID to dissolve
   */
  async dissolveGroup(chatId: string): Promise<void> {
    try {
      await this.client.im.chat.delete({
        path: {
          chat_id: chatId,
        },
      });

      this.logger.info({ chatId }, 'Group chat dissolved');
    } catch (error) {
      this.logger.error({ err: error, chatId }, 'Failed to dissolve group chat');
      throw error;
    }
  }

  /**
   * Add members to a group chat.
   *
   * @param chatId - The chat ID
   * @param userIds - User IDs to add (open_id format)
   */
  async addMembers(chatId: string, userIds: string[]): Promise<void> {
    try {
      await this.client.im.chatMembers.create({
        path: {
          chat_id: chatId,
        },
        data: {
          id_list: userIds,
        },
        params: {
          member_id_type: 'open_id',
        },
      });

      this.logger.info({ chatId, memberCount: userIds.length }, 'Members added to group chat');
    } catch (error) {
      this.logger.error({ err: error, chatId, userIds }, 'Failed to add members to group chat');
      throw error;
    }
  }

  /**
   * Remove members from a group chat.
   *
   * @param chatId - The chat ID
   * @param userIds - User IDs to remove (open_id format)
   */
  async removeMembers(chatId: string, userIds: string[]): Promise<void> {
    try {
      await this.client.im.chatMembers.delete({
        path: {
          chat_id: chatId,
        },
        data: {
          id_list: userIds,
        },
        params: {
          member_id_type: 'open_id',
        },
      });

      this.logger.info({ chatId, memberCount: userIds.length }, 'Members removed from group chat');
    } catch (error) {
      this.logger.error({ err: error, chatId, userIds }, 'Failed to remove members from group chat');
      throw error;
    }
  }

  /**
   * Get chat information.
   *
   * @param chatId - The chat ID
   * @returns Chat information
   */
  async getChatInfo(chatId: string): Promise<ChatInfo> {
    try {
      const response = await this.client.im.chat.get({
        path: {
          chat_id: chatId,
        },
        params: {
          user_id_type: 'open_id',
        },
      });

      const data = response?.data;
      if (!data) {
        throw new Error('Failed to get chat info from response');
      }

      // user_count is returned as string from API
      const memberCount = data.user_count ? parseInt(data.user_count, 10) : 0;

      const chatInfo: ChatInfo = {
        chatId,
        name: data.name || '',
        ownerId: data.owner_id || '',
        memberCount,
        description: data.description,
      };

      this.logger.debug({ chatId, chatInfo }, 'Retrieved chat info');
      return chatInfo;
    } catch (error) {
      this.logger.error({ err: error, chatId }, 'Failed to get chat info');
      throw error;
    }
  }

  /**
   * Get members of a group chat.
   *
   * @param chatId - The chat ID
   * @returns List of member user IDs (open_id format)
   */
  async getMembers(chatId: string): Promise<string[]> {
    try {
      const response = await this.client.im.chatMembers.get({
        path: {
          chat_id: chatId,
        },
        params: {
          member_id_type: 'open_id',
          page_size: 100,
        },
      });

      const members = response?.data?.items?.map((item: { member_id?: string }) => item.member_id).filter(Boolean) || [];

      this.logger.debug({ chatId, memberCount: members.length }, 'Retrieved chat members');
      return members as string[];
    } catch (error) {
      this.logger.error({ err: error, chatId }, 'Failed to get chat members');
      throw error;
    }
  }

  /**
   * Update chat information.
   *
   * @param chatId - The chat ID
   * @param updates - Fields to update
   */
  async updateChatInfo(
    chatId: string,
    updates: { name?: string; description?: string }
  ): Promise<void> {
    try {
      await this.client.im.chat.update({
        path: {
          chat_id: chatId,
        },
        data: {
          name: updates.name,
          description: updates.description,
        },
      });

      this.logger.info({ chatId, updates }, 'Chat info updated');
    } catch (error) {
      this.logger.error({ err: error, chatId, updates }, 'Failed to update chat info');
      throw error;
    }
  }
}
