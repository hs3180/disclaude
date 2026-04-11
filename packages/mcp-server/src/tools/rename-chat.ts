/**
 * rename_chat tool implementation.
 *
 * Renames a group chat via Feishu API through IPC.
 * Issue #2284: Auto-rename group chats based on task topic.
 *
 * @module mcp-server/tools/rename-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('RenameChat');

/**
 * Rename a group chat via IPC to PrimaryNode's FeishuChannel.
 * Issue #2284: Auto-rename group chats based on task topic.
 */
async function renameChatViaIpc(
  chatId: string,
  name: string
): Promise<{ success: boolean; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  return await ipcClient.updateChatName(chatId, name);
}

/**
 * Rename a group chat.
 *
 * @param params.chatId - Target chat ID (must be a group chat starting with 'oc_')
 * @param params.name - New display name for the chat (max 100 characters)
 */
export async function rename_chat(params: {
  chatId: string;
  name: string;
}): Promise<SendMessageResult> {
  const { chatId, name } = params;

  logger.info({
    chatId,
    namePreview: name.substring(0, 50),
  }, 'rename_chat called');

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }
    if (!name || name.trim().length === 0) {
      throw new Error('name is required and cannot be empty');
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

    logger.debug({ chatId, name }, 'Using IPC for chat rename');
    const result = await renameChatViaIpc(chatId, name.trim());
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC chat rename failed');
      return {
        success: false,
        error: result.error ?? 'Failed to rename chat via IPC',
        message: errorMsg,
      };
    }

    logger.debug({ chatId, name }, 'Chat renamed successfully');
    return { success: true, message: `✅ 群聊已重命名为「${name.trim()}」` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'rename_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 重命名群聊失败: ${errorMessage}` };
  }
}
