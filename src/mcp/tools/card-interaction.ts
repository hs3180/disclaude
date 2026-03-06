/**
 * Card interaction tools: update_card and wait_for_interaction.
 *
 * @module mcp/tools/card-interaction
 *
 * @deprecated These tools are deprecated. Use send_interactive_message instead.
 *
 * Migration Guide:
 * - update_card: Instead of updating cards, send new messages to reflect state changes
 * - wait_for_interaction: No replacement needed - interactions are automatically converted to messages
 *
 * The new approach:
 * 1. Use send_interactive_message to send interactive cards
 * 2. User interactions are automatically converted to prompts
 * 3. Process the prompts like regular messages
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import type { UpdateCardResult, WaitForInteractionResult, PendingInteraction } from './types.js';

const logger = createLogger('CardInteraction');

const pendingInteractions = new Map<string, PendingInteraction>();

export function resolvePendingInteraction(
  messageId: string,
  actionValue: string,
  actionType: string,
  userId: string
): boolean {
  const pending = pendingInteractions.get(messageId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingInteractions.delete(messageId);
    pending.resolve({ actionValue, actionType, userId });
    logger.debug({ messageId, actionValue, actionType, userId }, 'Pending interaction resolved');
    return true;
  }
  return false;
}

export async function update_card(params: {
  messageId: string;
  card: Record<string, unknown>;
  chatId: string;
}): Promise<UpdateCardResult> {
  const { messageId, card, chatId } = params;

  logger.info({ messageId, chatId }, 'update_card called');

  try {
    if (!messageId) { throw new Error('messageId is required'); }
    if (!card) { throw new Error('card is required'); }
    if (!chatId) { throw new Error('chatId is required'); }

    if (!isValidFeishuCard(card)) {
      return {
        success: false,
        error: `Invalid card structure: ${getCardValidationError(card)}`,
        message: `❌ Card validation failed. ${getCardValidationError(card)}`,
      };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      return {
        success: false,
        error: errorMsg,
        message: `❌ ${errorMsg}`,
      };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });

    logger.debug({ messageId, chatId }, 'Card updated successfully');
    return { success: true, message: '✅ Card updated successfully' };

  } catch (error) {
    logger.error({ err: error, messageId, chatId }, 'update_card failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to update card: ${errorMessage}` };
  }
}

export async function wait_for_interaction(params: {
  messageId: string;
  chatId: string;
  timeoutSeconds?: number;
}): Promise<WaitForInteractionResult> {
  const { messageId, chatId, timeoutSeconds = 300 } = params;

  logger.info({ messageId, chatId, timeoutSeconds }, 'wait_for_interaction called');

  try {
    if (!messageId) { throw new Error('messageId is required'); }
    if (!chatId) { throw new Error('chatId is required'); }

    if (pendingInteractions.has(messageId)) {
      return {
        success: false,
        error: 'Already waiting for interaction on this message',
        message: '❌ Another wait is already pending for this card',
      };
    }

    const interactionPromise = new Promise<{
      actionValue: string;
      actionType: string;
      userId: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingInteractions.delete(messageId);
        reject(new Error(`Interaction timeout after ${timeoutSeconds} seconds`));
      }, timeoutSeconds * 1000);

      pendingInteractions.set(messageId, { messageId, chatId, resolve, reject, timeout });
      logger.debug({ messageId, chatId, timeoutSeconds }, 'Waiting for interaction');
    });

    const result = await interactionPromise;

    logger.info({ messageId, chatId, actionValue: result.actionValue }, 'Interaction received');

    return {
      success: true,
      message: `✅ User interaction received: ${result.actionValue}`,
      actionValue: result.actionValue,
      actionType: result.actionType,
      userId: result.userId,
    };

  } catch (error) {
    pendingInteractions.delete(messageId);
    logger.error({ err: error, messageId, chatId }, 'wait_for_interaction failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Wait failed: ${errorMessage}` };
  }
}
