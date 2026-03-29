/**
 * mark_chat_responded tool implementation.
 *
 * Marks a temporary chat as responded by a user via IPC to Primary Node.
 * This prevents the lifecycle service from dissolving the chat on expiry,
 * since a responded chat indicates user interaction has occurred.
 *
 * Issue #1703: Temp chat lifecycle management.
 *
 * @module mcp-server/tools/mark-chat-responded
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { MarkChatRespondedResult } from './types.js';

const logger = createLogger('MarkChatResponded');

/**
 * Mark a temporary chat as responded by a user.
 *
 * @param params.chatId - The chat ID to update
 * @param params.selectedValue - The selected action value from the interactive card
 * @param params.responder - The open_id of the user who responded
 * @param params.repliedAt - ISO timestamp of the response (defaults to now)
 */
export async function mark_chat_responded(params: {
  chatId: string;
  selectedValue: string;
  responder: string;
  repliedAt?: string;
}): Promise<MarkChatRespondedResult> {
  const { chatId, selectedValue, responder, repliedAt } = params;

  logger.info({ chatId, selectedValue, responder }, 'mark_chat_responded called');

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
    const response = {
      selectedValue,
      responder,
      repliedAt: repliedAt ?? new Date().toISOString(),
    };
    const result = await ipcClient.markChatResponded(chatId, response);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'mark_chat_responded failed');
      return {
        success: false,
        error: result.error ?? 'Failed to mark chat as responded via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, responder }, 'Temp chat marked as responded');
    return {
      success: true,
      chatId,
      message: `✅ Temp chat marked as responded (chatId: ${chatId}, responder: ${responder})`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'mark_chat_responded FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to mark chat as responded: ${errorMessage}` };
  }
}
