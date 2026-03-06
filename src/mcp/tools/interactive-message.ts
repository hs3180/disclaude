/**
 * Interactive message tool: send_interactive_message.
 *
 * This tool is designed specifically for interactive cards with buttons, menus, etc.
 * Unlike send_user_feedback (which handles both text and static cards),
 * this tool focuses on interactive components and provides better guidance.
 *
 * @module mcp/tools/interactive-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import type { SendInteractiveResult, MessageSentCallback } from './types.js';

const logger = createLogger('InteractiveMessage');

let messageSentCallback: MessageSentCallback | null = null;

export function setInteractiveMessageSentCallback(callback: MessageSentCallback | null): void {
  messageSentCallback = callback;
}

function invokeMessageSentCallback(chatId: string): void {
  if (messageSentCallback) {
    try {
      messageSentCallback(chatId);
    } catch (error) {
      logger.error({ err: error }, 'Failed to invoke message sent callback');
    }
  }
}

/**
 * Send an interactive card message to a Feishu chat.
 *
 * This tool is specifically designed for interactive cards with buttons, menus,
 * input fields, and other interactive components. All user interactions will be
 * automatically converted to messages that the agent can process.
 *
 * ## Interactive Component Events
 *
 * When users interact with the card, the system will automatically generate
 * a message like:
 * - Button click: "[用户操作] 用户点击了「按钮文本」按钮。请根据此操作继续执行任务。"
 * - Menu selection: "[用户操作] 用户选择了「选项文本」。请根据此选择继续执行任务。"
 * - Input submission: "[用户操作] 用户提交了输入：「输入内容」。请根据此输入继续执行任务。"
 *
 * ## Best Practices
 *
 * 1. Use clear, action-oriented button text (e.g., "确认删除" instead of "确认")
 * 2. Include cancel/dismiss options for destructive actions
 * 3. Limit interactive cards to 4-5 buttons for better UX
 * 4. Use appropriate action values that your agent can understand
 *
 * @param params - The parameters for sending the interactive message
 * @returns Result with messageId for potential future operations
 */
export async function send_interactive_message(params: {
  /** The interactive card JSON structure (Feishu card format) */
  card: Record<string, unknown>;
  /** The Feishu chat ID to send the message to */
  chatId: string;
  /** Optional parent message ID for thread replies */
  parentMessageId?: string;
  /** Optional description of what this card is for (for logging) */
  description?: string;
}): Promise<SendInteractiveResult> {
  const { card, chatId, parentMessageId, description } = params;

  logger.info({
    chatId,
    parentMessageId,
    description,
    cardPreview: JSON.stringify(card).substring(0, 200),
  }, 'send_interactive_message called');

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
        error: `Invalid Feishu card structure: ${getCardValidationError(card)}`,
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

    // Send the interactive card
    const response = await sendMessageToFeishu(
      client,
      chatId,
      'interactive',
      JSON.stringify(card),
      parentMessageId
    );

    // Extract messageId from response if available
    const messageId = (response as { data?: { message_id?: string } })?.data?.message_id;

    logger.debug({ chatId, parentMessageId, messageId }, 'Interactive message sent');

    invokeMessageSentCallback(chatId);

    return {
      success: true,
      message: '✅ Interactive message sent successfully',
      messageId,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_interactive_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send interactive message: ${errorMessage}`,
    };
  }
}

/**
 * Tool description for send_interactive_message.
 * This is used when registering the tool with the MCP server.
 */
export const SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION = `Send an interactive card message with buttons, menus, or other interactive components.

## When to Use This Tool

Use this tool when you need to:
- Present choices to the user (confirmation dialogs, selections)
- Collect user input through form fields
- Create actionable notifications

## How Interactive Events Work

**IMPORTANT**: You do NOT need to wait for or handle callbacks. When users interact with the card:
1. The system captures the interaction event
2. It automatically generates a descriptive message
3. The message appears in the chat as if the user sent it
4. You process it like any other message

Example: If a user clicks a "确认" button, you'll receive:
"[用户操作] 用户点击了「确认」按钮。请根据此操作继续执行任务。"

## Card Structure

The card parameter must follow Feishu's interactive card JSON format:
- Use "config" for card-level settings
- Use "elements" array for card content
- Use "actions" in elements for interactive components

## Best Practices

1. Use clear, descriptive button text (e.g., "确认删除" not just "确认")
2. Always include a cancel/dismiss option for important actions
3. Keep button count reasonable (3-5 max for better UX)
4. Use meaningful action values that describe the intent`;
