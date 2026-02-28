/**
 * Feishu Chat Manager - Manages Feishu group chats for log messages.
 *
 * This module implements the log group creation feature from Issue #347:
 * - Create new log group chats for users
 * - Add users to log groups
 * - Reuse existing log groups
 *
 * @see Issue #347
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { getAdminStatusManager } from '../../messaging/admin-status-manager.js';

const logger = createLogger('FeishuChatManager');

/**
 * Result of getting or creating a log chat.
 */
export interface LogChatResult {
  /** Chat ID */
  chatId: string;
  /** Whether the chat was newly created */
  created: boolean;
}

/**
 * Options for FeishuChatManager.
 */
export interface FeishuChatManagerOptions {
  /** Feishu API client */
  client: lark.Client;
  /** Bot name for chat naming */
  botName?: string;
}

/**
 * Manager for Feishu group chats.
 *
 * Provides functionality to:
 * - Create log group chats for users
 * - Add users to groups
 * - Find existing log groups
 *
 * @example
 * ```typescript
 * const manager = new FeishuChatManager({ client });
 *
 * // Get or create a log chat for a user
 * const result = await manager.getOrCreateLogChat('user_123', 'John Doe');
 * console.log(result.chatId); // 'oc_xxx'
 * console.log(result.created); // true if newly created
 * ```
 */
export class FeishuChatManager {
  private readonly client: lark.Client;
  private readonly botName: string;

  constructor(options: FeishuChatManagerOptions) {
    this.client = options.client;
    this.botName = options.botName ?? 'Disclaude';
  }

  /**
   * Get or create a log chat for a user.
   *
   * This method:
   * 1. Checks if user already has a log chat ID stored
   * 2. If stored, verifies the chat still exists
   * 3. If not stored or invalid, creates a new chat
   * 4. Adds the user to the chat if needed
   *
   * @param userId - Feishu user ID (open_id)
   * @param userName - User display name for chat naming
   * @returns Log chat result with chat ID and creation status
   */
  async getOrCreateLogChat(userId: string, userName?: string): Promise<LogChatResult> {
    const adminManager = getAdminStatusManager();

    // Check if user already has a log chat
    const existingChatId = adminManager.getLogChatId(userId);
    if (existingChatId) {
      // Verify the chat still exists
      const exists = await this.chatExists(existingChatId);
      if (exists) {
        logger.info({ userId, chatId: existingChatId }, 'Reusing existing log chat');
        return { chatId: existingChatId, created: false };
      }
      logger.warn({ userId, chatId: existingChatId }, 'Stored log chat no longer exists');
    }

    // Create a new log chat
    const chatName = userName
      ? `${this.botName} 日志 - ${userName}`
      : `${this.botName} 日志`;

    const newChatId = await this.createChat(chatName);
    if (!newChatId) {
      throw new Error('Failed to create log chat');
    }

    // Add the user to the chat
    const added = await this.addMember(newChatId, userId);
    if (!added) {
      logger.warn({ userId, chatId: newChatId }, 'Failed to add user to log chat, but chat was created');
    }

    // Store the chat ID
    await adminManager.setLogChatId(userId, newChatId);

    logger.info({ userId, chatId: newChatId, chatName }, 'Created new log chat');
    return { chatId: newChatId, created: true };
  }

  /**
   * Create a new group chat.
   *
   * @param name - Chat name
   * @returns Chat ID, or undefined on failure
   */
  private async createChat(name: string): Promise<string | undefined> {
    try {
      const response = await this.client.im.chat.create({
        params: {
          set_bot_manager: true,
        },
        data: {
          name,
          chat_mode: 'group',
          chat_type: 'private',
          join_message_visibility: 'all_members',
          leave_message_visibility: 'all_members',
          membership_approval: 'no_approval_required',
          only_owner_add: false,
          only_owner_at_all: false,
          only_owner_edit: false,
          share_allowed_card: false,
          user_id_type: 'open_id',
        } as unknown as Record<string, unknown>,
      });

      const chatId = response?.data?.chat_id;
      if (chatId) {
        logger.info({ chatId, name }, 'Created group chat');
        return chatId;
      }

      logger.error({ response }, 'Failed to create chat: no chat_id in response');
      return undefined;
    } catch (error) {
      logger.error({ error, name }, 'Failed to create group chat');
      return undefined;
    }
  }

  /**
   * Add a member to a chat.
   *
   * @param chatId - Chat ID
   * @param userId - User ID (open_id)
   * @returns true if successful
   */
  async addMember(chatId: string, userId: string): Promise<boolean> {
    try {
      await this.client.im.chatMembers.create({
        path: {
          chat_id: chatId,
        },
        params: {
          member_id_type: 'open_id',
        },
        data: {
          member_id_list: [userId],
        },
      });

      logger.info({ chatId, userId }, 'Added member to chat');
      return true;
    } catch (error) {
      // Check if error is because user is already in chat
      const err = error as { code?: number; message?: string };
      if (err.code === 230001 || err.message?.includes('already in chat')) {
        logger.debug({ chatId, userId }, 'User already in chat');
        return true;
      }

      logger.error({ error, chatId, userId }, 'Failed to add member to chat');
      return false;
    }
  }

  /**
   * Remove a member from a chat.
   *
   * @param chatId - Chat ID
   * @param userId - User ID (open_id)
   * @returns true if successful
   */
  async removeMember(chatId: string, userId: string): Promise<boolean> {
    try {
      await this.client.im.chatMembers.delete({
        path: {
          chat_id: chatId,
          member_id: userId,
        },
        params: {
          member_id_type: 'open_id',
        },
      });

      logger.info({ chatId, userId }, 'Removed member from chat');
      return true;
    } catch (error) {
      logger.error({ error, chatId, userId }, 'Failed to remove member from chat');
      return false;
    }
  }

  /**
   * Check if a chat exists.
   *
   * @param chatId - Chat ID
   * @returns true if chat exists
   */
  async chatExists(chatId: string): Promise<boolean> {
    try {
      await this.client.im.chat.get({
        path: {
          chat_id: chatId,
        },
      });
      return true;
    } catch (error) {
      const err = error as { code?: number };
      // Chat not found
      if (err.code === 230001) {
        return false;
      }
      // Other error, assume chat exists to avoid unnecessary creation
      logger.warn({ error, chatId }, 'Error checking chat existence, assuming exists');
      return true;
    }
  }

  /**
   * Get chat info.
   *
   * @param chatId - Chat ID
   * @returns Chat info, or undefined if not found
   */
  async getChatInfo(chatId: string): Promise<lark.im.chat.GetResponseBody | undefined> {
    try {
      const response = await this.client.im.chat.get({
        path: {
          chat_id: chatId,
        },
      });
      return response.data;
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to get chat info');
      return undefined;
    }
  }
}

// Singleton instance (lazy initialized)
let defaultInstance: FeishuChatManager | undefined;

/**
 * Get the default FeishuChatManager instance.
 *
 * @param client - Feishu client (required for first call)
 */
export function getFeishuChatManager(client?: lark.Client): FeishuChatManager {
  if (!defaultInstance) {
    if (!client) {
      throw new Error('FeishuChatManager not initialized: client required');
    }
    defaultInstance = new FeishuChatManager({ client });
  }
  return defaultInstance;
}

/**
 * Set the default FeishuChatManager instance (for testing).
 */
export function setFeishuChatManager(manager: FeishuChatManager): void {
  defaultInstance = manager;
}

/**
 * Reset the default instance (for testing).
 */
export function resetFeishuChatManager(): void {
  defaultInstance = undefined;
}
