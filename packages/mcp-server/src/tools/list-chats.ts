/**
 * list_chats tool implementation.
 *
 * Lists all chats the bot is in via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports chat listing.
 *
 * Issue #1678: Group member management MCP tools.
 *
 * @module mcp-server/tools/list-chats
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { ListChatsResult } from './types.js';

const logger = createLogger('ListChats');

/**
 * List all chats the bot is in.
 */
export async function list_chats(): Promise<ListChatsResult> {
  logger.info('list_chats called');

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
    const result = await ipcClient.listChats();

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'list_chats failed');
      return {
        success: false,
        error: result.error ?? 'Failed to list chats via IPC',
        message: errorMsg,
      };
    }

    const chats = result.chats ?? [];
    logger.info({ chatCount: chats.length }, 'Chats listed');
    return {
      success: true,
      chats,
      message: `✅ Bot is in ${chats.length} chat(s)`,
    };

  } catch (error) {
    logger.error({ err: error }, 'list_chats FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to list chats: ${errorMessage}` };
  }
}
