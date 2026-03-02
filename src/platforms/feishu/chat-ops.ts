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
  /** Chat topic/name */
  topic: string;
  /** Initial member open_ids */
  members: string[];
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
 * Create a discussion group chat.
 *
 * @param client - Feishu API client
 * @param options - Chat creation options
 * @returns The created chat ID
 * @throws Error if chat creation fails
 */
export async function createDiscussionChat(
  client: lark.Client,
  options: CreateDiscussionOptions
): Promise<string> {
  const { topic, members } = options;
  const log = logger;

  try {
    const response = await client.im.chat.create({
      data: {
        name: topic,
        chat_mode: 'group',
        chat_type: 'group',
        user_id_list: members,
      },
      params: {
        user_id_type: 'open_id',
      },
    });

    const chatId = response?.data?.chat_id;
    if (!chatId) {
      throw new Error('Failed to get chat_id from response');
    }

    log.info({ chatId, topic, memberCount: members.length }, 'Discussion chat created');
    return chatId;
  } catch (error) {
    log.error({ err: error, topic }, 'Failed to create discussion chat');
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
