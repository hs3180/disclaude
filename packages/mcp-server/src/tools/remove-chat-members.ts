/**
 * remove_chat_members tool implementation.
 *
 * Removes members from a group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports member management.
 *
 * Issue #1678: Group member management MCP tools.
 *
 * @module mcp-server/tools/remove-chat-members
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { RemoveChatMembersResult } from './types.js';

const logger = createLogger('RemoveChatMembers');

/**
 * Remove members from a group chat.
 *
 * @param params.chatId - Target chat ID
 * @param params.memberIds - Array of member IDs to remove (platform decides ID format)
 */
export async function remove_chat_members(params: {
  chatId: string;
  memberIds: string[];
}): Promise<RemoveChatMembersResult> {
  const { chatId, memberIds } = params;

  logger.info({ chatId, memberCount: memberIds.length }, 'remove_chat_members called');

  try {
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

    const ipcClient = getIpcClient();
    const result = await ipcClient.removeChatMembers(chatId, memberIds);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'remove_chat_members failed');
      return {
        success: false,
        error: result.error ?? 'Failed to remove chat members via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, memberCount: memberIds.length }, 'Chat members removed');
    return {
      success: true,
      chatId,
      message: `✅ Removed ${memberIds.length} member(s) from chat (chatId: ${chatId})`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'remove_chat_members FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to remove members: ${errorMessage}` };
  }
}
