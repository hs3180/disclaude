/**
 * list_temp_chats tool implementation.
 *
 * Lists all tracked temporary chats via IPC to Primary Node.
 * Useful for checking status of temp chats and their expiry times.
 *
 * Issue #1703: Temp chat lifecycle management.
 *
 * @module mcp-server/tools/list-temp-chats
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { ListTempChatsResult } from './types.js';

const logger = createLogger('ListTempChats');

/**
 * List all tracked temporary chats.
 *
 * Returns an array of temp chat records with their status (active/expired/responded).
 */
export async function list_temp_chats(): Promise<ListTempChatsResult> {
  logger.info('list_temp_chats called');

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
    const result = await ipcClient.listTempChats();

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'list_temp_chats failed');
      return {
        success: false,
        error: result.error ?? 'Failed to list temp chats via IPC',
        message: errorMsg,
      };
    }

    const chatCount = result.chats?.length ?? 0;
    logger.info({ chatCount }, 'Temp chats listed');
    return {
      success: true,
      chats: result.chats,
      message: `✅ Found ${chatCount} tracked temp chat(s)`,
    };

  } catch (error) {
    logger.error({ err: error }, 'list_temp_chats FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to list temp chats: ${errorMessage}` };
  }
}
