/**
 * ChatOps - Simple chat operations for FeedbackController.
 *
 * A lightweight wrapper for Feishu chat operations, designed to be used
 * as internal utility functions rather than a standalone complex service.
 *
 * @see Issue #402 - ChatManager simplified to ~50 lines
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ChatOps');

/**
 * Options for creating a discussion chat.
 */
export interface CreateDiscussionOptions {
  /** Chat topic/name (optional, auto-generated if not provided) */
  topic?: string;
  /** Initial member open_ids (optional, creator will be auto-added) */
  members?: string[];
}

/**
 * ChatOps configuration.
 */
export interface ChatOpsConfig {
  /** Feishu API client */
  client: lark.Client;
  /** Optional logger */
  logger?: Logger;
}

/**
 * Generate a default group name based on timestamp.
 *
 * @returns Auto-generated group name
 */
function generateDefaultGroupName(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `讨论组 ${dateStr} ${timeStr}`;
}

/**
 * Create a discussion group chat.
 *
 * @param client - Feishu API client
 * @param options - Chat creation options
 * @param creatorId - Optional creator open_id to auto-add as member
 * @returns The created chat ID
 * @throws Error if chat creation fails
 */
export async function createDiscussionChat(
  client: lark.Client,
  options: CreateDiscussionOptions = {},
  creatorId?: string
): Promise<string> {
  const { topic, members } = options;
  const log = logger;

  // Auto-generate topic if not provided
  const chatName = topic || generateDefaultGroupName();

  // Build member list: use provided members, or add creator if available
  let memberList = members || [];
  if (memberList.length === 0 && creatorId) {
    memberList = [creatorId];
  }

  try {
    const response = await client.im.chat.create({
      data: {
        name: chatName,
        chat_mode: 'group',
        chat_type: 'group',
        user_id_list: memberList,
      },
      params: {
        user_id_type: 'open_id',
      },
    });

    const chatId = response?.data?.chat_id;
    if (!chatId) {
      throw new Error('Failed to get chat_id from response');
    }

    log.info({ chatId, topic: chatName, memberCount: memberList.length }, 'Discussion chat created');
    return chatId;
  } catch (error) {
    log.error({ err: error, topic: chatName }, 'Failed to create discussion chat');
    throw error;
  }
}

/**
 * Dissolve (delete) a group chat.
 *
 * @param client - Feishu API client
 * @param chatId - Chat ID to dissolve
 */
export async function dissolveChat(client: lark.Client, chatId: string): Promise<void> {
  try {
    await client.im.chat.delete({
      path: { chat_id: chatId },
    });
    logger.info({ chatId }, 'Chat dissolved');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to dissolve chat');
    throw error;
  }
}

/**
 * Add members to a chat.
 *
 * @param client - Feishu API client
 * @param chatId - Target chat ID
 * @param members - Member open_ids to add
 */
export async function addMembers(
  client: lark.Client,
  chatId: string,
  members: string[]
): Promise<void> {
  try {
    await client.im.chatMembers.create({
      path: { chat_id: chatId },
      data: { id_list: members },
      params: { member_id_type: 'open_id' },
    });
    logger.info({ chatId, memberCount: members.length }, 'Members added');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to add members');
    throw error;
  }
}

/**
 * Remove members from a chat.
 *
 * @param client - Feishu API client
 * @param chatId - Target chat ID
 * @param members - Member open_ids to remove
 */
export async function removeMembers(
  client: lark.Client,
  chatId: string,
  members: string[]
): Promise<void> {
  try {
    await client.im.chatMembers.delete({
      path: { chat_id: chatId },
      data: { id_list: members },
      params: { member_id_type: 'open_id' },
    });
    logger.info({ chatId, memberCount: members.length }, 'Members removed');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to remove members');
    throw error;
  }
}

/**
 * Get members of a chat.
 *
 * @param client - Feishu API client
 * @param chatId - Target chat ID
 * @returns Array of member open_ids
 */
export async function getMembers(
  client: lark.Client,
  chatId: string
): Promise<string[]> {
  try {
    const response = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id' },
    });

    const members = response?.data?.items
      ?.map((item) => item.member_id)
      .filter((id): id is string => !!id) || [];
    logger.info({ chatId, memberCount: members.length }, 'Members retrieved');
    return members;
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to get members');
    throw error;
  }
}

/**
 * Chat info from Feishu API.
 */
export interface BotChatInfo {
  /** Chat ID */
  chatId: string;
  /** Chat name */
  name: string;
}

/**
 * Update chat name.
 *
 * @param client - Feishu API client
 * @param chatId - Target chat ID
 * @param name - New chat name
 *
 * @see Issue #1072 - Thread Management (建群+自动命名 MVP)
 */
export async function updateChatName(
  client: lark.Client,
  chatId: string,
  name: string
): Promise<void> {
  try {
    await client.im.chat.update({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' },
      data: { name },
    });
    logger.info({ chatId, name }, 'Chat name updated');
  } catch (error) {
    logger.error({ err: error, chatId, name }, 'Failed to update chat name');
    throw error;
  }
}

/**
 * Get all chats the bot is in.
 *
 * Uses Feishu API to get all groups where the bot is a member.
 * This provides accurate data compared to local registry.
 *
 * @param client - Feishu API client
 * @returns Array of chat info
 */
export async function getBotChats(
  client: lark.Client
): Promise<BotChatInfo[]> {
  const chats: BotChatInfo[] = [];
  let pageToken: string | undefined;

  try {
    // Paginate through all chats
    do {
      const response = await client.im.chat.list({
        params: {
          page_size: 50,
          page_token: pageToken,
        },
      });

      const items = response?.data?.items || [];
      for (const item of items) {
        if (item.chat_id && item.name) {
          chats.push({
            chatId: item.chat_id,
            name: item.name,
          });
        }
      }

      pageToken = response?.data?.page_token;
    } while (pageToken);

    logger.info({ chatCount: chats.length }, 'Bot chats retrieved');
    return chats;
  } catch (error) {
    logger.error({ err: error }, 'Failed to get bot chats');
    throw error;
  }
}
