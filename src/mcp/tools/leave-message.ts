/**
 * leave_message tool implementation (Issue #631).
 *
 * Non-blocking offline message system for Agent to leave messages
 * that users can reply to at any time.
 *
 * @module mcp/tools/leave-message
 */

import { createLogger } from '../../utils/logger.js';
import { send_user_feedback } from './send-message.js';
import type { LeaveMessageResult } from './types.js';
import { getOfflineMessageStore } from '../../messaging/offline-message-store.js';

const logger = createLogger('LeaveMessage');

/**
 * Build an offline message card with optional context.
 */
function buildOfflineMessageCard(
  message: string,
  context?: string
): Record<string, unknown> {
  const elements: Array<{ tag: string; content?: string; elements?: Array<{ tag: string; content: string }> }> = [
    {
      tag: 'markdown',
      content: message,
    },
  ];

  // Add context section if provided
  if (context) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `上下文: ${context.substring(0, 200)}${context.length > 200 ? '...' : ''}`,
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📝 Agent 留言' },
      template: 'turquoise',
    },
    elements,
  };
}

/**
 * Leave a non-blocking message for the user (Issue #631).
 *
 * Sends a message to the user without waiting for a response.
 * When the user replies, a callback can be triggered to handle the response.
 *
 * This is useful for:
 * - Asking questions that don't need immediate answers
 * - Leaving reminders or status updates
 * - Starting async discussions
 *
 * @param params - Tool parameters
 * @returns Result object with messageId for tracking
 */
export async function leave_message(params: {
  message: string;
  chatId: string;
  context?: string;
  callbackAction?: 'create_task' | 'trigger_skill' | 'record_knowledge';
  callbackParams?: Record<string, unknown>;
}): Promise<LeaveMessageResult> {
  const {
    message,
    chatId,
    context,
    callbackAction = 'create_task',
    callbackParams,
  } = params;

  logger.info({
    message: message.substring(0, 100),
    chatId,
    callbackAction,
    hasContext: !!context,
  }, 'leave_message called');

  try {
    if (!message) {
      throw new Error('message is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // CLI mode: Just log the message
    if (chatId.startsWith('cli-')) {
      logger.info({ chatId, message }, 'CLI mode: Offline message logged');
      return {
        success: true,
        message: '✅ Offline message logged (CLI mode)',
        messageId: `cli-${Date.now()}`,
      };
    }

    // Build and send the message card
    const card = buildOfflineMessageCard(message, context);

    const sendResult = await send_user_feedback({
      content: card,
      format: 'card',
      chatId,
    });

    if (!sendResult.success) {
      return {
        success: false,
        error: sendResult.error,
        message: `❌ Failed to send offline message: ${sendResult.message}`,
      };
    }

    const { messageId } = sendResult;
    if (!messageId) {
      return {
        success: false,
        error: 'No message ID returned from send',
        message: '❌ Failed to get message ID for tracking',
      };
    }

    // Store the offline message context for callback handling
    const store = getOfflineMessageStore();

    await store.save({
      id: messageId,
      chatId,
      question: message,
      agentContext: context,
      callbackAction,
      callbackParams,
    });

    logger.info({
      messageId,
      chatId,
      callbackAction,
    }, 'Offline message sent and stored');

    return {
      success: true,
      message: '✅ Offline message sent. User can reply at any time.',
      messageId,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error({
      err: error,
      chatId,
      message: message.substring(0, 100),
    }, 'leave_message failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Leave message failed: ${errorMessage}`,
    };
  }
}
