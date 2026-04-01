/**
 * remove_members tool implementation.
 *
 * Removes members from a group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports member management.
 *
 * @module mcp-server/tools/remove-members
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { RemoveMembersResult } from './types.js';

const logger = createLogger('RemoveMembers');

/**
 * Remove members from a group chat.
 *
 * @param params.chatId - Target chat ID
 * @param params.memberIds - Member IDs to remove
 */
export async function remove_members(params: {
  chatId: string;
  memberIds: string[];
}): Promise<RemoveMembersResult> {
  const { chatId, memberIds } = params;

  logger.info({ chatId, memberCount: memberIds.length }, 'remove_members called');

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
    const result = await ipcClient.removeMembers(chatId, memberIds);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'remove_members failed');
      return {
        success: false,
        error: result.error ?? 'Failed to remove members via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, removedCount: result.removedCount }, 'Members removed');
    return {
      success: true,
      chatId,
      removedCount: result.removedCount ?? memberIds.length,
      message: `✅ Members removed (chatId: ${chatId}, count: ${result.removedCount ?? memberIds.length})`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'remove_members FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to remove members: ${errorMessage}` };
  }
}
