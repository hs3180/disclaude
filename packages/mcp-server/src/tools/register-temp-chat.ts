/**
 * register_temp_chat tool implementation.
 *
 * Registers a temporary chat for lifecycle tracking via IPC to Primary Node.
 * The Primary Node will automatically dissolve expired chats.
 *
 * Issue #1703: Temp chat lifecycle management.
 * Issue #2069: Added passiveMode for declarative passive mode configuration.
 *
 * @module mcp-server/tools/register-temp-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { RegisterTempChatResult } from './types.js';

const logger = createLogger('RegisterTempChat');

/**
 * Register a temporary chat for lifecycle tracking.
 *
 * @param params.chatId - The chat ID to track
 * @param params.expiresAt - Optional ISO timestamp for expiry (defaults to 24h)
 * @param params.creatorChatId - Optional originating chat ID
 * @param params.context - Optional arbitrary context data
 * @param params.triggerMode - Optional trigger mode enum ('mention' | 'always', Issue #2291)
 */
export async function register_temp_chat(params: {
  chatId: string;
  expiresAt?: string;
  creatorChatId?: string;
  context?: Record<string, unknown>;
  triggerMode?: 'mention' | 'always';
}): Promise<RegisterTempChatResult> {
  const { chatId, expiresAt, creatorChatId, context, triggerMode } = params;

  logger.info({ chatId, expiresAt, creatorChatId, triggerMode }, 'register_temp_chat called');

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
    const result = await ipcClient.registerTempChat(chatId, expiresAt, creatorChatId, context, { triggerMode });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'register_temp_chat failed');
      return {
        success: false,
        error: result.error ?? 'Failed to register temp chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, expiresAt: result.expiresAt, triggerMode }, 'Temp chat registered');
    const modeDesc = triggerMode ? `, trigger mode: ${triggerMode}` : '';
    return {
      success: true,
      chatId: result.chatId,
      expiresAt: result.expiresAt,
      message: `✅ Temporary chat registered (chatId: ${result.chatId ?? chatId}, expiresAt: ${result.expiresAt ?? '24h default'}${modeDesc})`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'register_temp_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to register temp chat: ${errorMessage}` };
  }
}
