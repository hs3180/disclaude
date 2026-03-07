/**
 * ChatOps MCP tool implementation.
 *
 * Exposes ChatOps functions (createDiscussionChat, etc.) as MCP tools
 * for use in scheduled tasks and agent workflows.
 *
 * @module mcp/tools/chat-ops
 * @see Issue #393 - PR Scanner
 * @see PR #423 - ChatOps utility
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import {
  createDiscussionChat,
  addMembers,
  getMembers,
  getBotChats,
  type CreateDiscussionOptions,
  type BotChatInfo,
} from '../../platforms/feishu/chat-ops.js';

const logger = createLogger('ChatOpsTool');

export interface CreateDiscussionChatResult {
  success: boolean;
  chatId?: string;
  error?: string;
  message: string;
}

export interface GetBotChatsResult {
  success: boolean;
  chats?: BotChatInfo[];
  error?: string;
  message: string;
}

export interface ChatMembersResult {
  success: boolean;
  members?: string[];
  error?: string;
  message: string;
}

/**
 * Create a discussion group chat.
 *
 * @param params - Chat creation parameters
 * @returns Result with chat ID on success
 */
export async function create_discussion_chat(params: {
  topic?: string;
  members?: string[];
}): Promise<CreateDiscussionChatResult> {
  const { topic, members } = params;

  logger.info({ topic, memberCount: members?.length || 0 }, 'create_discussion_chat called');

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET.';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    const options: CreateDiscussionOptions = {};
    if (topic) {
      options.topic = topic;
    }
    if (members && members.length > 0) {
      options.members = members;
    }

    const chatId = await createDiscussionChat(client, options);

    logger.info({ chatId, topic }, 'Discussion chat created successfully');
    return {
      success: true,
      chatId,
      message: `✅ Discussion chat created: ${chatId}${topic ? ` (${topic})` : ''}`,
    };
  } catch (error) {
    logger.error({ err: error, topic }, 'Failed to create discussion chat');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create chat: ${errorMessage}` };
  }
}

/**
 * Get all chats the bot is in.
 *
 * @returns List of bot chats
 */
export async function get_bot_chats(): Promise<GetBotChatsResult> {
  logger.info('get_bot_chats called');

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured.';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const chats = await getBotChats(client);

    logger.info({ chatCount: chats.length }, 'Bot chats retrieved');
    return {
      success: true,
      chats,
      message: `✅ Found ${chats.length} chats`,
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to get bot chats');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get chats: ${errorMessage}` };
  }
}

/**
 * Add members to a chat.
 *
 * @param params - Chat ID and members to add
 * @returns Result
 */
export async function add_chat_members(params: {
  chatId: string;
  members: string[];
}): Promise<ChatMembersResult> {
  const { chatId, members } = params;

  logger.info({ chatId, memberCount: members.length }, 'add_chat_members called');

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      return { success: false, error: 'Feishu credentials not configured.', message: '❌ Credentials not configured.' };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    await addMembers(client, chatId, members);

    return {
      success: true,
      members,
      message: `✅ Added ${members.length} member(s) to chat`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to add members: ${errorMessage}` };
  }
}

/**
 * Get members of a chat.
 *
 * @param params - Chat ID
 * @returns List of member IDs
 */
export async function get_chat_members(params: { chatId: string }): Promise<ChatMembersResult> {
  const { chatId } = params;

  logger.info({ chatId }, 'get_chat_members called');

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      return { success: false, error: 'Feishu credentials not configured.', message: '❌ Credentials not configured.' };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const members = await getMembers(client, chatId);

    return {
      success: true,
      members,
      message: `✅ Chat has ${members.length} member(s)`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get members: ${errorMessage}` };
  }
}
