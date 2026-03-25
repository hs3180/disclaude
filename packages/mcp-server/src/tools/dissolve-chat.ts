/**
 * dissolve_chat tool implementation.
 *
 * Dissolves (deletes) a group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports group dissolution.
 *
 * @module mcp-server/tools/dissolve-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { DissolveChatResult } from './types.js';

const logger = createLogger('DissolveChat');

/**
 * Dissolve a group chat.
 *
 * @param params.chatId - Chat ID to dissolve
 */
export async function dissolve_chat(params: {
  chatId: string;
}): Promise<DissolveChatResult> {
  const { chatId } = params;

  logger.info({ chatId }, 'dissolve_chat called');

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
    const result = await ipcClient.dissolveChat(chatId);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'dissolve_chat failed');
      return {
        success: false,
        error: result.error ?? 'Failed to dissolve chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId }, 'Group chat dissolved');
    return {
      success: true,
      chatId,
      message: `✅ Group chat dissolved (chatId: ${chatId})`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'dissolve_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to dissolve chat: ${errorMessage}` };
  }
}
