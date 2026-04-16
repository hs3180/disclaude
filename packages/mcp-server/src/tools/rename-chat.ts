/**
 * rename_chat tool implementation.
 *
 * Renames a Feishu group chat via IPC to Primary Node.
 * Issue #2284: Auto-rename group when bot is added and given a task.
 *
 * @module mcp-server/tools/rename-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { RenameChatResult } from './types.js';

const logger = createLogger('RenameChat');

/**
 * Rename a Feishu group chat.
 *
 * @param params.chatId - Target group chat ID (must start with 'oc_')
 * @param params.name - New name for the group (max 150 characters)
 */
export async function rename_chat(params: {
  chatId: string;
  name: string;
}): Promise<RenameChatResult> {
  const { chatId, name } = params;

  logger.info({ chatId, name }, 'rename_chat called');

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }
    if (!name || name.trim().length === 0) {
      throw new Error('name is required and cannot be empty');
    }
    if (name.length > 150) {
      throw new Error('name must be 150 characters or less');
    }
    if (!chatId.startsWith('oc_')) {
      throw new Error('chatId must be a group chat ID (starting with oc_)');
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

    const ipcClient = getIpcClient();
    const result = await ipcClient.renameChat(chatId, name.trim());

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'rename_chat IPC failed');
      return {
        success: false,
        error: result.error ?? 'Failed to rename chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, name }, 'Group renamed successfully');
    return { success: true, message: `✅ 群名称已修改为「${name.trim()}」` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'rename_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 修改群名称失败: ${errorMessage}` };
  }
}
