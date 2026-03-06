/**
 * create_group tool implementation.
 *
 * Allows agents to create Feishu group chats.
 *
 * @see Issue #393 - PR Scanner scheduled task
 * @module mcp/tools/create-group
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getGroupService } from '../../platforms/feishu/group-service.js';
import type { CreateGroupResult } from './types.js';

const logger = createLogger('CreateGroup');

/**
 * Create a Feishu group chat.
 *
 * @param params - Group creation parameters
 * @param params.topic - Group name/topic (optional, auto-generated if not provided)
 * @param params.members - Initial member open_ids (optional)
 * @returns Result with chatId and name on success
 */
export async function create_group(params: {
  topic?: string;
  members?: string[];
}): Promise<CreateGroupResult> {
  const { topic, members } = params;

  logger.info({
    topic,
    memberCount: members?.length || 0,
  }, 'create_group called');

  try {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const groupService = getGroupService();

    // Create the group using GroupService
    const groupInfo = await groupService.createGroup(client, {
      topic,
      members,
    });

    logger.info({
      chatId: groupInfo.chatId,
      name: groupInfo.name,
    }, 'Group created successfully');

    return {
      success: true,
      chatId: groupInfo.chatId,
      name: groupInfo.name,
      message: `✅ Group created: ${groupInfo.name} (chatId: ${groupInfo.chatId})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'create_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create group: ${errorMessage}` };
  }
}
