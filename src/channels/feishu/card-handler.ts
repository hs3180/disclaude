/**
 * Card Handler for Feishu Channel.
 *
 * Handles interactive card action events.
 */

import { createLogger } from '../../utils/logger.js';
import { resolvePendingInteraction } from '../../mcp/feishu-context-mcp.js';
import type { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import type {
  FeishuCardActionEvent,
  FeishuCardActionEventData,
} from '../../types/platform.js';
import type { IncomingMessage } from '../types.js';

const logger = createLogger('CardHandler');

/**
 * Callbacks required from the channel for card handling.
 */
export interface CardHandlerCallbacks {
  /** Check if the channel is running */
  isRunning: () => boolean;
  /** Emit an incoming message */
  emitMessage: (message: IncomingMessage) => Promise<void>;
  /** Send a message through the channel */
  sendMessage: (message: { chatId: string; type: string; text: string }) => Promise<void>;
}

/**
 * CardHandler - Handles interactive card action events.
 *
 * This class encapsulates all the logic for:
 * - Resolving pending interactions
 * - Emitting card actions as messages to agent
 * - InteractionManager handling
 */
export class CardHandler {
  constructor(
    private callbacks: CardHandlerCallbacks,
    private interactionManager: InteractionManager
  ) {}

  /**
   * Handle card action event from WebSocket.
   * Triggered when user clicks button, selects menu, etc. on an interactive card.
   */
  async handleCardAction(data: FeishuCardActionEventData): Promise<void> {
    if (!this.callbacks.isRunning()) {
      return;
    }

    const event = (data.event || data) as FeishuCardActionEvent;
    const { action, message_id, chat_id, user } = event;

    if (!action || !message_id || !chat_id) {
      logger.warn('Missing required card action fields');
      return;
    }

    logger.info(
      {
        messageId: message_id,
        chatId: chat_id,
        actionType: action.type,
        actionValue: action.value,
        trigger: action.trigger,
        userId: user?.sender_id?.open_id,
      },
      'Card action received'
    );

    // First, try to resolve any pending wait_for_interaction calls
    const resolved = resolvePendingInteraction(
      message_id,
      action.value,
      action.type,
      user?.sender_id?.open_id || 'unknown'
    );

    if (resolved) {
      logger.debug({ messageId: message_id }, 'Card action resolved pending interaction');
      // Issue #657: Continue to emit message to agent instead of returning early
      // This allows the agent to handle the interaction and decide what to do next
    }

    // Issue #657: Always emit card action as a message to the agent
    // This enables the agent to handle user interactions and take appropriate actions
    try {
      // Get button text for user-friendly message
      const buttonText = action.text || action.value;
      const messageContent = `User clicked '${buttonText}' button`;

      await this.callbacks.emitMessage({
        messageId: `${message_id}-${action.value}`,
        chatId: chat_id,
        userId: user?.sender_id?.open_id,
        content: messageContent,
        messageType: 'card',
        timestamp: Date.now(),
        metadata: {
          cardAction: action,
          cardMessageId: message_id,
          wasPendingInteraction: resolved,
        },
      });

      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value },
        'Card action emitted as message to agent'
      );
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
    }

    // Return early if resolved - the wait_for_interaction tool already returned the result
    if (resolved) {
      return;
    }

    try {
      // Try to handle via InteractionManager
      const handled = await this.interactionManager.handleAction(event, async (defaultEvent) => {
        // Default handler: emit as interaction message
        // Issue #525: Use button text to generate user-friendly prompt
        const buttonText = defaultEvent.action.text || defaultEvent.action.value;
        const messageContent = `The user clicked '${buttonText}' button`;

        await this.callbacks.emitMessage({
          messageId: `${defaultEvent.message_id}-${defaultEvent.action.value}`,
          chatId: defaultEvent.chat_id,
          userId: defaultEvent.user?.sender_id?.open_id,
          content: messageContent,
          messageType: 'card',
          timestamp: Date.now(),
          metadata: {
            cardAction: defaultEvent.action,
            cardMessageId: defaultEvent.message_id,
          },
        });
      });

      if (!handled) {
        logger.debug(
          { messageId: message_id, actionValue: action.value },
          'Card action not handled'
        );
      }
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Card action handler error');

      // Notify user of the error
      await this.callbacks.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: `❌ 处理卡片操作时发生错误：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }
}
