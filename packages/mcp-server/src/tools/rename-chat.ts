/**
 * rename_chat tool implementation.
 *
 * Renames a Feishu group chat via IPC to PrimaryNode's LarkClientService.
 * Issue #2284: Auto-rename group when bot is added and given a task.
 *
 * @module mcp-server/tools/rename-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';

const logger = createLogger('RenameChat');

/**
 * Result type for rename_chat tool.
 */
export interface RenameChatResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Rename a Feishu group chat via IPC.
 * Issue #2284: Rename group to match task topic.
 *
 * @param params.chatId - Target chat ID
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
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Validate chatId is a group chat (oc_ prefix)
    if (!chatId.startsWith('oc_')) {
      throw new Error('rename_chat can only be used with group chats (chatId must start with "oc_")');
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
    const result = await ipcClient.renameChat(chatId, name);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'rename_chat failed via IPC');
      return {
        success: false,
        error: result.error ?? 'Failed to rename chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, name }, 'Chat renamed successfully');
    return { success: true, message: `✅ 群聊已更名为「${name}」` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'rename_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 重命名群聊失败: ${errorMessage}` };
  }
}
