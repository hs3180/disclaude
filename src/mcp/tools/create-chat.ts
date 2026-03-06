/**
 * Create Discussion Chat MCP Tool
 *
 * Creates a new group chat in Feishu for discussion purposes.
 * Used by scheduled tasks like PR Scanner to create dedicated chat groups.
 *
 * @see Issue #393 - PR Scanner Phase 2
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { createDiscussionChat, type CreateDiscussionOptions } from '../../platforms/feishu/chat-ops.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('create-chat');

/**
 * Result type for create_discussion_chat tool.
 */
export interface CreateChatResult {
  success: boolean;
  message: string;
  chatId?: string;
}

/**
 * Create a new discussion group chat.
 *
 * @param params - Chat creation parameters
 * @returns Result with chat ID on success
 */
export async function create_discussion_chat(params: {
  /** Chat topic/name (optional, auto-generated if not provided) */
  topic?: string;
  /** Initial member open_ids (optional) */
  members?: string[];
}): Promise<CreateChatResult> {
  const { topic, members } = params;

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      return {
        success: false,
        message: 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET.',
      };
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

    logger.info({ chatId, topic }, 'Discussion chat created via MCP tool');

    return {
      success: true,
      message: 'Discussion chat created successfully.',
      chatId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, topic }, 'Failed to create discussion chat');

    return {
      success: false,
      message: `Failed to create discussion chat: ${errorMessage}`,
    };
  }
}
