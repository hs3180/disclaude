/**
 * create_group tool implementation.
 *
 * Creates a new Feishu group chat and registers it with GroupService.
 *
 * @module mcp/tools/create-group
 * @see Issue #393 - 定时扫描 PR 并创建讨论群聊
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getGroupService } from '../../platforms/feishu/group-service.js';

const logger = createLogger('CreateGroup');

export interface CreateGroupResult {
  success: boolean;
  chatId?: string;
  name?: string;
  error?: string;
  message: string;
}

/**
 * Create a new Feishu group chat.
 *
 * @param params - Group creation parameters
 * @returns Result with chat ID and status
 */
export async function create_group(params: {
  /** Group name/topic (optional, auto-generated if not provided) */
  name?: string;
  /** Initial member open_ids (optional) */
  members?: string[];
  /** Purpose/description for the group (optional) */
  description?: string;
}): Promise<CreateGroupResult> {
  const { name, members, description } = params;

  logger.info({
    name,
    memberCount: members?.length || 0,
    hasDescription: !!description,
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
      topic: name,
      members,
    });

    logger.info({ chatId: groupInfo.chatId, name: groupInfo.name }, 'Group created successfully');

    // Build success message
    let message = '✅ Group created successfully!\n';
    message += `**Chat ID**: \`${groupInfo.chatId}\`\n`;
    message += `**Name**: ${groupInfo.name}\n`;
    if (groupInfo.initialMembers.length > 0) {
      message += `**Members**: ${groupInfo.initialMembers.length} user(s)`;
    }
    if (description) {
      message += `\n**Description**: ${description}`;
    }

    return {
      success: true,
      chatId: groupInfo.chatId,
      name: groupInfo.name,
      message,
    };

  } catch (error) {
    logger.error({ err: error, name }, 'create_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create group: ${errorMessage}` };
  }
}
