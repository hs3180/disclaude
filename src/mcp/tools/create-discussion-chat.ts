/**
 * create_discussion_chat tool implementation.
 *
 * Creates a new group chat for discussions (e.g., PR discussions).
 * Issue #393: PR Scanner - Group chat creation support.
 *
 * @module mcp/tools/create-discussion-chat
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { createDiscussionChat } from '../../platforms/feishu/chat-ops.js';

const logger = createLogger('CreateDiscussionChat');

/**
 * Result type for create_discussion_chat tool.
 */
export interface CreateDiscussionChatResult {
  success: boolean;
  chatId?: string;
  error?: string;
  message: string;
}

/**
 * Create a discussion group chat.
 *
 * @param params - Chat creation parameters
 * @returns Result with chat ID or error
 */
export async function create_discussion_chat(params: {
  topic: string;
  members?: string[];
}): Promise<CreateDiscussionChatResult> {
  const { topic, members } = params;

  logger.info({
    topic,
    memberCount: members?.length || 0,
  }, 'create_discussion_chat called');

  try {
    if (!topic) {
      throw new Error('topic is required');
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ topic }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Create Feishu client and create the chat
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const chatId = await createDiscussionChat(client, { topic, members });

    logger.info({ chatId, topic, memberCount: members?.length || 0 }, 'Discussion chat created');
    return {
      success: true,
      chatId,
      message: `✅ Discussion chat created: ${topic}\nChat ID: ${chatId}`,
    };

  } catch (error) {
    logger.error({ err: error, topic }, 'create_discussion_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create discussion chat: ${errorMessage}` };
  }
}
