/**
 * create_group tool implementation.
 *
 * This tool creates a new group chat in Feishu.
 *
 * @module mcp-server/tools/create-group
 * @see Issue #1391 - Temporary session management
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('CreateGroup');

/**
 * Create a group chat via IPC to PrimaryNode's LarkClientService.
 * Issue #1391: Routes Feishu API calls through unified client.
 */
async function createGroupViaIpc(
  topic?: string,
  members?: string[]
): Promise<{ success: boolean; chatId?: string; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  return await ipcClient.feishuCreateGroup(topic, members);
}

/**
 * Create a new group chat in Feishu.
 *
 * @param params.topic - Optional group name/topic
 * @param params.members - Optional array of member open_ids
 */
export async function create_group(params: {
  topic?: string;
  members?: string[];
}): Promise<SendMessageResult & { chatId?: string }> {
  const { topic, members } = params;

  logger.info({
    topic,
    memberCount: members?.length ?? 0,
  }, 'create_group called');

  try {
    // Get Feishu credentials
    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    logger.debug({ topic, members }, 'Using IPC for group creation');
    const result = await createGroupViaIpc(topic, members);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'IPC group creation failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create group via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId: result.chatId, topic }, 'Group created successfully');
    return {
      success: true,
      chatId: result.chatId,
      message: `✅ 群聊创建成功${topic ? `: ${topic}` : ''}`,
    };

  } catch (error) {
    logger.error({ err: error }, 'create_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create group: ${errorMessage}` };
  }
}
