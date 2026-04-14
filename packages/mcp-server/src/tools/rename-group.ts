/**
 * rename_chat tool implementation.
 *
 * Renames a Feishu group chat via IPC to the Primary Node.
 * Used by the agent to auto-rename group chats when assigned a task.
 *
 * Issue #2284: Auto-rename group when bot is added and assigned a task.
 *
 * @module mcp-server/tools/rename-group
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('RenameGroup');

/**
 * Rename a Feishu group chat via IPC.
 *
 * @param params.chatId - Target group chat ID (must start with 'oc_')
 * @param params.groupName - New name for the group (max 64 characters)
 */
export async function rename_chat(params: {
  chatId: string;
  groupName: string;
}): Promise<SendMessageResult> {
  const { chatId, groupName } = params;

  logger.info({
    chatId,
    groupName,
  }, 'rename_chat called');

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }
    if (!groupName || groupName.trim().length === 0) {
      throw new Error('groupName is required and cannot be empty');
    }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    // Truncate group name to max length (64 chars)
    const truncatedName = Array.from(groupName).slice(0, 64).join('');

    logger.debug({ chatId, groupName: truncatedName }, 'Using IPC for group rename');
    const ipcClient = getIpcClient();
    const result = await ipcClient.renameGroup(chatId, truncatedName);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC group rename failed');
      return {
        success: false,
        error: result.error ?? 'Failed to rename group via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, groupName: truncatedName }, 'Group renamed successfully');
    return { success: true, message: `✅ 群名称已更改为: ${truncatedName}` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'rename_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to rename group: ${errorMessage}` };
  }
}
