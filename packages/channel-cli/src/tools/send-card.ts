/**
 * send_card tool implementation for display-only cards.
 *
 * This tool sends static cards without interactive elements (buttons, menus).
 * For interactive cards with button click handlers, use send_interactive instead.
 *
 * @module channel-cli/tools/send-card
 */

import { createLogger, sendCard, type FeishuCard, type ChannelApiMethodResult } from '@disclaude/core';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { isChannelApiAvailable, getChannelApiErrorMessage, getChannelApiClient, buildChannelApiFallbackHint } from './channel-api-utils.js';
import { invokeMessageSentCallback } from './callback-manager.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('SendCard');

/**
 * Send card message via REST API to DisclaudeService's LarkClientService.
 */
async function sendCardViaChannelApi(
  chatId: string,
  card: Record<string, unknown>,
  threadId?: string,
  description?: string
): Promise<ChannelApiMethodResult & { messageId?: string }> {
  // Issue #4280 (Phase 3, part 3): REST-only — direct ChannelApiClient.
  const apiClient = getChannelApiClient();
  // Card has been validated by isValidFeishuCard() before this call
  return await sendCard(apiClient, chatId, card as FeishuCard, threadId, description);
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

    // Card preprocessing is performed by the channel CLI before this transport function.

    // Check REST API availability (Issue #1355: async connection probe)
    if (!(await isChannelApiAvailable())) {
      const errorMsg = 'REST API service unavailable. Please ensure disclaude service is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        // Issue #4576: actionable fallback — +messages-send loses thread
        // attribution in topic groups; +messages-reply preserves it.
        message: `❌ REST API 服务不可用。请检查 disclaude service 服务是否正在运行。${buildChannelApiFallbackHint(parentMessageId)}`,
      };
    }

    logger.debug({ chatId, parentMessageId }, 'Using REST API for card message');
    const result = await sendCardViaChannelApi(chatId, card, parentMessageId);
    if (!result.success) {
      const errorMsg = getChannelApiErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'REST API card message failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send card via REST API',
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
