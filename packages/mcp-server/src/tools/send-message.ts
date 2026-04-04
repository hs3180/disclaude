/**
 * send_text tool implementation.
 *
 * This tool sends plain text messages to Feishu chats.
 * For cards, use send_card or send_interactive instead.
 *
 * @module mcp-server/tools/send-message
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { invokeMessageSentCallback, setMessageSentCallback, getMessageSentCallback } from './callback-manager.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('SendText');

// Re-export callback functions for backward compatibility
export { setMessageSentCallback, getMessageSentCallback };

/**
 * Send text message via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1088: Improved error handling with detailed error information.
 */
async function sendMessageViaIpc(
  chatId: string,
  text: string,
  threadId?: string,
  mentions?: Array<{ openId: string; name?: string }>
): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  return await ipcClient.sendMessage(chatId, text, threadId, mentions);
}

/**
 * Send a plain text message to a Feishu chat.
 *
 * @param params.text - The text content to send
 * @param params.chatId - Target chat ID
 * @param params.parentMessageId - Optional parent message ID for thread reply
 */
export async function send_text(params: {
  text: string;
  chatId: string;
  parentMessageId?: string;
  mentions?: Array<{ openId: string; name?: string }>;
}): Promise<SendMessageResult> {
  const { text, chatId, parentMessageId, mentions } = params;

  logger.info({
    chatId,
    textPreview: text.substring(0, 100),
    hasParent: !!parentMessageId,
  }, 'send_text called');

  try {
    if (!text) {
      throw new Error('text is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Check IPC availability (Issue #1355: async connection probe)
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    logger.debug({ chatId, parentMessageId }, 'Using IPC for text message');
    const result = await sendMessageViaIpc(chatId, text, parentMessageId, mentions);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC text message failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send message via IPC',
        message: errorMsg,
      };
    }

    invokeMessageSentCallback(chatId);
    logger.debug({ chatId, parentMessageId }, 'Text message sent');
    return { success: true, message: '✅ Text message sent' };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_text FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send text: ${errorMessage}` };
  }
}

// Re-export helper for other tools (backward compatibility)
export { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
