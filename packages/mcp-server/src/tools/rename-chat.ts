/**
 * rename_chat tool implementation.
 *
 * Renames a Feishu group chat. Used by the agent to automatically
 * set a descriptive group name when assigned a task in a new group.
 *
 * Issue #2284: Auto-rename group to match task topic.
 *
 * @module mcp-server/tools/rename-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { RenameChatResult } from './types.js';

const logger = createLogger('RenameChat');

/**
 * Rename a Feishu group chat via IPC to PrimaryNode's LarkClientService.
 *
 * @param params.chatId - Target chat ID to rename
 * @param params.name - New name for the group chat
 */
export async function rename_chat(params: {
  chatId: string;
  name: string;
}): Promise<RenameChatResult> {
  const { chatId, name } = params;

  logger.info({
    chatId,
    name,
  }, 'rename_chat called');

  try {
    if (!name || !name.trim()) {
      throw new Error('name is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Check IPC availability (Issue #1355: async connection probe)
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    logger.debug({ chatId, name }, 'Using IPC for rename chat');
    const ipcClient = getIpcClient();
    const result = await ipcClient.renameChat(chatId, name.trim());
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC renameChat failed');
      return {
        success: false,
        error: result.error ?? 'Failed to rename chat via IPC',
        message: errorMsg,
      };
    }

    logger.debug({ chatId, name }, 'Chat renamed');
    return { success: true, message: `✅ 群聊已重命名为「${name.trim()}」` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'rename_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to rename chat: ${errorMessage}` };
  }
}
