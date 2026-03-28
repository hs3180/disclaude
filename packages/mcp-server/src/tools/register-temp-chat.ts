/**
 * register_temp_chat tool implementation.
 *
 * Registers a temporary chat via IPC to Primary Node, beginning its lifecycle tracking.
 * The Primary Node's lifecycle service will automatically dissolve the chat when it expires.
 *
 * Issue #1703: Temporary chat lifecycle management (Phase 4).
 * Follows the create_chat / dissolve_chat thin-wrapper pattern.
 *
 * @module mcp-server/tools/register-temp-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type {
  RegisterTempChatResult,
  ListTempChatsResult,
  MarkChatRespondedResult,
} from './types.js';

const logger = createLogger('RegisterTempChat');

/**
 * Register a temporary chat, beginning its lifecycle tracking.
 *
 * @param params.chatId - Chat ID of the temporary group (required)
 * @param params.expiresAt - ISO timestamp when the chat should expire (optional, defaults to 24h)
 * @param params.creatorChatId - Chat ID where the creation request originated (optional)
 * @param params.context - Arbitrary context data (optional)
 */
export async function register_temp_chat(params: {
  chatId: string;
  expiresAt?: string;
  creatorChatId?: string;
  context?: Record<string, unknown>;
}): Promise<RegisterTempChatResult> {
  const { chatId, expiresAt, creatorChatId, context } = params;

  logger.info({ chatId, expiresAt, creatorChatId }, 'register_temp_chat called');

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
    const result = await ipcClient.registerTempChat(chatId, { expiresAt, creatorChatId, context });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'register_temp_chat failed');
      return {
        success: false,
        error: result.error ?? 'Failed to register temp chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, expiresAt: result.expiresAt }, 'Temp chat registered');
    return {
      success: true,
      chatId: result.chatId,
      expiresAt: result.expiresAt,
      message: `✅ Temporary chat registered (chatId: ${result.chatId}, expires: ${result.expiresAt ?? '24h default'})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'register_temp_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to register temp chat: ${errorMessage}` };
  }
}

/**
 * List all temporary chats currently being tracked.
 */
export async function list_temp_chats(): Promise<ListTempChatsResult> {
  logger.info('list_temp_chats called');

  try {
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
    logger.info({ chatCount }, 'Listed temp chats');

    if (chatCount === 0) {
      return {
        success: true,
        chats: [],
        message: '📋 No temporary chats currently tracked.',
      };
    }

    const chatList = (result.chats ?? []).map((c: {
      chatId: string;
      createdAt: string;
      expiresAt: string;
      creatorChatId?: string;
      responded: boolean;
    }) =>
      `- ${c.chatId} (expires: ${c.expiresAt}, responded: ${c.responded ? '✅' : '⏳'})`
    ).join('\n');

    return {
      success: true,
      chats: result.chats,
      message: `📋 Tracking ${chatCount} temporary chat(s):\n${chatList}`,
    };

  } catch (error) {
    logger.error({ err: error }, 'list_temp_chats FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to list temp chats: ${errorMessage}` };
  }
}

/**
 * Mark a temporary chat as responded by a user.
 *
 * @param params.chatId - Chat ID of the temporary group
 * @param params.selectedValue - The value of the button the user clicked
 * @param params.responder - User identifier who responded
 */
export async function mark_chat_responded(params: {
  chatId: string;
  selectedValue: string;
  responder: string;
}): Promise<MarkChatRespondedResult> {
  const { chatId, selectedValue, responder } = params;

  logger.info({ chatId, selectedValue, responder }, 'mark_chat_responded called');

  try {
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
    const result = await ipcClient.markChatResponded(chatId, {
      selectedValue,
      responder,
      repliedAt: new Date().toISOString(),
    });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'mark_chat_responded failed');
      return {
        success: false,
        error: result.error ?? 'Failed to mark chat as responded via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId, responder }, 'Temp chat marked as responded');
    return {
      success: true,
      message: `✅ Temporary chat marked as responded (chatId: ${chatId}, responder: ${responder})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'mark_chat_responded FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to mark chat as responded: ${errorMessage}` };
  }
}
