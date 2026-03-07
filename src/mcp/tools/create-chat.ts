/**
 * create_chat MCP tool implementation.
 *
 * Creates a new group chat in Feishu.
 *
 * @module mcp/tools/create-chat
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { createDiscussionChat } from '../../platforms/feishu/chat-ops.js';

const logger = createLogger('CreateChat');

export interface CreateChatResult {
  success: boolean;
  chatId?: string;
  error?: string;
  message: string;
}

/**
 * Create a new group chat in Feishu.
 *
 * @param params - Chat creation parameters
 * @param params.topic - Chat name/topic (optional, auto-generated if not provided)
 * @param params.members - Initial member open_ids (optional)
 * @returns Result with chat ID on success
 */
export async function create_chat(params: {
  topic?: string;
  members?: string[];
}): Promise<CreateChatResult> {
  const { topic, members } = params;

  logger.info({
    topic,
    memberCount: members?.length || 0,
  }, 'create_chat called');

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    const chatId = await createDiscussionChat(client, {
      topic,
      members,
    });

    logger.info({ chatId, topic }, 'Chat created successfully');
    return {
      success: true,
      chatId,
      message: `✅ Chat created: ${topic || 'Untitled'} (ID: ${chatId})`,
    };

  } catch (error) {
    logger.error({ err: error, topic }, 'create_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create chat: ${errorMessage}` };
  }
}
