/**
 * send_card tool implementation for display-only cards.
 *
 * This tool sends static cards without interactive elements (buttons, menus).
 * For interactive cards with button click handlers, use send_interactive instead.
 *
 * @module mcp-server/tools/send-card
 */

import { createLogger, getIpcClient, type FeishuCard } from '@disclaude/core';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { transformCardTables } from '../utils/table-converter.js';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { invokeMessageSentCallback } from './callback-manager.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('SendCard');

/**
 * Send card message via IPC to PrimaryNode's LarkClientService.
 */
async function sendCardViaIpc(
  chatId: string,
  card: Record<string, unknown>,
  threadId?: string,
  description?: string
): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  // Card has been validated by isValidFeishuCard() before this call
  return await ipcClient.sendCard(chatId, card as FeishuCard, threadId, description);
}

/**
 * Send a display-only card message to a Feishu chat.
 *
 * Use this for static cards without interactive elements (buttons, menus).
 * For interactive cards with button click handlers, use send_interactive instead.
 *
 * @param params.card - The Feishu card JSON structure
 * @param params.chatId - Target chat ID
 * @param params.parentMessageId - Optional parent message ID for thread reply
 */
export async function send_card(params: {
  card: Record<string, unknown>;
  chatId: string;
  parentMessageId?: string;
}): Promise<SendMessageResult> {
  const { card, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    hasParent: !!parentMessageId,
    cardPreview: JSON.stringify(card).substring(0, 100),
  }, 'send_card called');

  try {
    if (!card) {
      throw new Error('card is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Validate card structure
    if (!isValidFeishuCard(card)) {
      return {
        success: false,
        error: `Invalid card structure: ${getCardValidationError(card)}`,
        message: `❌ Card validation failed. ${getCardValidationError(card)}.`,
      };
    }

    // Issue #2340: Auto-convert GFM tables in markdown elements to column_set
    const processedCard = transformCardTables(card);

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

    logger.debug({ chatId, parentMessageId }, 'Using IPC for card message');
    const result = await sendCardViaIpc(chatId, processedCard, parentMessageId);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC card message failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send card via IPC',
        message: errorMsg,
      };
    }

    invokeMessageSentCallback(chatId);
    logger.debug({ chatId, parentMessageId }, 'Card message sent');
    return { success: true, message: '✅ Card message sent' };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_card FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send card: ${errorMessage}` };
  }
}

// Re-export helper for backward compatibility
export { getFeishuCredentials } from './credentials.js';
