/**
 * get_chat_members tool implementation.
 *
 * Gets the list of members in a group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports member listing.
 *
 * Issue #1678: Group member management MCP tools.
 *
 * @module mcp-server/tools/get-chat-members
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { GetChatMembersResult } from './types.js';

const logger = createLogger('GetChatMembers');

/**
 * Get members of a group chat.
 *
 * @param params.chatId - Target chat ID
 */
export async function get_chat_members(params: {
  chatId: string;
}): Promise<GetChatMembersResult> {
  const { chatId } = params;

  logger.info({ chatId }, 'get_chat_members called');

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
    const result = await ipcClient.getChatMembers(chatId);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'get_chat_members failed');
      return {
        success: false,
        error: result.error ?? 'Failed to get chat members via IPC',
        message: errorMsg,
      };
    }

    const members = result.members ?? [];
    logger.info({ chatId, memberCount: members.length }, 'Chat members retrieved');
    return {
      success: true,
      chatId,
      members,
      message: `✅ Chat has ${members.length} member(s) (chatId: ${chatId})`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'get_chat_members FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get members: ${errorMessage}` };
  }
}
