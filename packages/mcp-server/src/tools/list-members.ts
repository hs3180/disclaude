/**
 * list_members tool implementation.
 *
 * Lists members of a group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports member listing.
 *
 * @module mcp-server/tools/list-members
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { GetMembersResult } from './types.js';

const logger = createLogger('ListMembers');

/**
 * Get members of a group chat.
 *
 * @param params.chatId - Target chat ID
 */
export async function list_members(params: {
  chatId: string;
}): Promise<GetMembersResult> {
  const { chatId } = params;

  logger.info({ chatId }, 'list_members called');

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
    const result = await ipcClient.getMembers(chatId);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'list_members failed');
      return {
        success: false,
        error: result.error ?? 'Failed to get members via IPC',
        message: errorMsg,
      };
    }

    const memberIds = result.memberIds ?? [];
    logger.info({ chatId, memberCount: memberIds.length }, 'Members listed');
    return {
      success: true,
      memberIds,
      message: `✅ Chat ${chatId} has ${memberIds.length} member(s): ${memberIds.join(', ')}`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'list_members FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to list members: ${errorMessage}` };
  }
}
