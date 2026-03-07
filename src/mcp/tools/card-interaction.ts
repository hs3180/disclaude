/**
 * Card interaction tools: wait_for_interaction.
 *
 * @module mcp/tools/card-interaction
 */

import { createLogger } from '../../utils/logger.js';
import type { WaitForInteractionResult, PendingInteraction } from './types.js';

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
