/**
 * Card interaction tools implementation.
 *
 * This module provides tools for updating cards and waiting for user interactions.
 * Part of the Feishu MCP tool suite (Issue #275 Phase 4).
 */

import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createClient } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import type { PendingInteraction, UpdateCardResult, WaitForInteractionResult } from './types.js';

const logger = createLogger('CardInteraction');

/**
 * Global map of pending interactions waiting for user response.
 */
const pendingInteractions = new Map<string, PendingInteraction>();

/**
 * Handle incoming card action for wait_for_interaction.
 * Called by FeishuChannel when a card action is received.
 *
 * @param messageId - The card message ID
 * @param actionValue - The action value from the button click
 * @param actionType - The action type (button, menu, etc.)
 * @param userId - The user who triggered the action
 */
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

/**
 * Tool: Update an existing interactive card message.
 *
 * Updates the content of a previously sent interactive card.
 * Requires the message_id of the card to update.
 *
 * @param params - Tool parameters
 * @returns Result object with success status
 */
export async function update_card(params: {
  messageId: string;
  card: Record<string, unknown>;
  chatId: string;
}): Promise<UpdateCardResult> {
  const { messageId, card, chatId } = params;

  logger.info({
    messageId,
    chatId,
    cardPreview: JSON.stringify(card).substring(0, 100),
  }, 'update_card called');

  try {
    if (!messageId) {
      throw new Error('messageId is required');
    }
    if (!card) {
      throw new Error('card is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Validate card structure
    if (!isValidFeishuCard(card)) {
      const validationError = getCardValidationError(card);
      return {
        success: false,
        error: `Invalid card structure: ${validationError}`,
        message: `❌ Card validation failed. ${validationError}`,
      };
    }

    // CLI mode: Log the update instead of calling API
    if (chatId.startsWith('cli-')) {
      logger.info({ messageId, chatId }, 'CLI mode: Card update simulated');
      return {
        success: true,
        message: '✅ Card updated (CLI mode)',
      };
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    // Graceful degradation: When Feishu credentials are not configured,
    // return a soft error instead of throwing. This allows the agent to
    // continue execution in REST channel and test environments.
    if (!appId || !appSecret) {
      logger.warn({
        messageId,
        chatId,
        reason: 'Feishu credentials not configured'
      }, 'Card update skipped (Feishu not configured)');

      return {
        success: false,
        error: 'Feishu credentials not configured',
        message: '⚠️ Card cannot be updated: Feishu is not configured.',
      };
    }

    // Create Lark client
    const client = createClient(appId, appSecret);

    // Update the card using patch API
    await client.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });

    logger.debug({ messageId, chatId }, 'Card updated successfully');

    return {
      success: true,
      message: '✅ Card updated successfully',
    };

  } catch (error) {
    logger.error({
      err: error,
      messageId,
      chatId,
    }, 'update_card failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to update card: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Wait for user to interact with a card.
 *
 * Registers a wait handler for the specified card and returns when
 * the user clicks a button or interacts with the card.
 *
 * Note: This tool will block until the user interacts or timeout is reached.
 * The interaction is resolved via resolvePendingInteraction() called by FeishuChannel.
 *
 * @param params - Tool parameters
 * @returns Result object with the action taken by the user
 */
export async function wait_for_interaction(params: {
  messageId: string;
  chatId: string;
  timeoutSeconds?: number;
}): Promise<WaitForInteractionResult> {
  const { messageId, chatId, timeoutSeconds = 300 } = params;

  logger.info({
    messageId,
    chatId,
    timeoutSeconds,
  }, 'wait_for_interaction called');

  try {
    if (!messageId) {
      throw new Error('messageId is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // CLI mode: Simulate immediate response
    if (chatId.startsWith('cli-')) {
      logger.info({ messageId, chatId }, 'CLI mode: Simulating interaction response');
      return {
        success: true,
        message: '✅ Interaction received (CLI mode - simulated)',
        actionValue: 'simulated',
        actionType: 'button',
        userId: 'cli-user',
      };
    }

    // Check if there's already a pending interaction for this message
    if (pendingInteractions.has(messageId)) {
      return {
        success: false,
        error: 'Already waiting for interaction on this message',
        message: '❌ Another wait is already pending for this card',
      };
    }

    // Create a promise that resolves when the user interacts
    const interactionPromise = new Promise<{
      actionValue: string;
      actionType: string;
      userId: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingInteractions.delete(messageId);
        reject(new Error(`Interaction timeout after ${timeoutSeconds} seconds`));
      }, timeoutSeconds * 1000);

      pendingInteractions.set(messageId, {
        messageId,
        chatId,
        resolve,
        reject,
        timeout,
      });

      logger.debug({ messageId, chatId, timeoutSeconds }, 'Waiting for interaction');
    });

    // Wait for the interaction
    const result = await interactionPromise;

    logger.info({
      messageId,
      chatId,
      actionValue: result.actionValue,
      actionType: result.actionType,
      userId: result.userId,
    }, 'Interaction received');

    return {
      success: true,
      message: `✅ User interaction received: ${result.actionValue}`,
      actionValue: result.actionValue,
      actionType: result.actionType,
      userId: result.userId,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Clean up pending interaction on error
    pendingInteractions.delete(messageId);

    logger.error({
      err: error,
      messageId,
      chatId,
    }, 'wait_for_interaction failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Wait failed: ${errorMessage}`,
    };
  }
}
