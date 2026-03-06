/**
 * Interactive message tool implementation.
 *
 * This tool sends interactive cards with pre-defined prompt templates
 * that are automatically converted to user messages when interactions occur.
 *
 * Uses cross-process shared storage for interaction contexts to support
 * scenarios where MCP and bot processes are separate.
 *
 * @module mcp/tools/interactive-message
 * @see Issue #894 - 飞书卡片按钮点击无响应
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { getMessageSentCallback } from './send-message.js';
import {
  registerInteractionContext,
  getActionPrompts as getSharedActionPrompts,
  unregisterInteractionContext,
  cleanupExpiredContexts as cleanupSharedExpiredContexts,
} from '../../utils/interaction-state.js';
import type { SendInteractiveResult, ActionPromptMap } from './types.js';

const logger = createLogger('InteractiveMessage');

/**
 * Register action prompts for a message.
 * Called after successfully sending an interactive message.
 * Uses cross-process shared storage.
 */
export function registerActionPrompts(
  messageId: string,
  chatId: string,
  actionPrompts: ActionPromptMap
): void {
  registerInteractionContext(messageId, chatId, actionPrompts);
}

/**
 * Get action prompts for a message.
 * Returns undefined if no prompts are registered.
 * Uses cross-process shared storage.
 */
export function getActionPrompts(messageId: string): ActionPromptMap | undefined {
  return getSharedActionPrompts(messageId);
}

/**
 * Remove action prompts for a message.
 * Uses cross-process shared storage.
 */
export function unregisterActionPrompts(messageId: string): boolean {
  return unregisterInteractionContext(messageId);
}

/**
 * Generate a prompt from an interaction using the registered template.
 *
 * @param messageId - The card message ID
 * @param actionValue - The action value from the button/menu
 * @param actionText - The display text of the action (optional)
 * @param actionType - The type of action (button, select_static, etc.)
 * @param formData - Form data if the action includes form inputs
 * @returns The generated prompt or undefined if no template found
 */
export function generateInteractionPrompt(
  messageId: string,
  actionValue: string,
  actionText?: string,
  actionType?: string,
  formData?: Record<string, unknown>
): string | undefined {
  const prompts = getActionPrompts(messageId);
  if (!prompts) {
    return undefined;
  }

  const template = prompts[actionValue];
  if (!template) {
    logger.debug(
      { messageId, actionValue, availableActions: Object.keys(prompts) },
      'No prompt template found for action'
    );
    return undefined;
  }

  // Replace placeholders in the template
  let prompt = template;

  // Replace {{actionText}} placeholder
  if (actionText) {
    prompt = prompt.replace(/\{\{actionText\}\}/g, actionText);
  }

  // Replace {{actionValue}} placeholder
  prompt = prompt.replace(/\{\{actionValue\}\}/g, actionValue);

  // Replace {{actionType}} placeholder
  if (actionType) {
    prompt = prompt.replace(/\{\{actionType\}\}/g, actionType);
  }

  // Replace form data placeholders
  if (formData) {
    for (const [key, value] of Object.entries(formData)) {
      const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
      prompt = prompt.replace(placeholder, String(value));
    }
  }

  return prompt;
}

/**
 * Cleanup expired interactive contexts (older than 24 hours).
 * Uses cross-process shared storage.
 */
export function cleanupExpiredContexts(): number {
  return cleanupSharedExpiredContexts();
}

/**
 * Send an interactive message with pre-defined action prompts.
 *
 * When the user interacts with the card (clicks a button, selects from menu, etc.),
 * the corresponding prompt template will be used to generate a message that the
 * agent receives as if the user had typed it.
 *
 * @example
 * ```typescript
 * await send_interactive_message({
 *   card: {
 *     config: { wide_screen_mode: true },
 *     header: { title: { tag: "plain_text", content: "Confirm Action" } },
 *     elements: [
 *       {
 *         tag: "action",
 *         actions: [
 *           { tag: "button", text: { tag: "plain_text", content: "Confirm" }, value: "confirm" },
 *           { tag: "button", text: { tag: "plain_text", content: "Cancel" }, value: "cancel" }
 *         ]
 *       }
 *     ]
 *   },
 *   actionPrompts: {
 *     confirm: "[用户操作] 用户点击了「确认」按钮。请继续执行任务。",
 *     cancel: "[用户操作] 用户点击了「取消」按钮。任务已取消。"
 *   },
 *   chatId: "oc_xxx"
 * });
 * ```
 */
export async function send_interactive_message(params: {
  /** The interactive card JSON structure */
  card: Record<string, unknown>;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
}): Promise<SendInteractiveResult> {
  const { card, actionPrompts, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    actionCount: Object.keys(actionPrompts).length,
    hasParent: !!parentMessageId,
  }, 'send_interactive_message called');

  try {
    // Validate required parameters
    if (!card) {
      throw new Error('card is required');
    }
    if (!actionPrompts || Object.keys(actionPrompts).length === 0) {
      throw new Error('actionPrompts is required and must have at least one action');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Validate card structure
    if (!isValidFeishuCard(card)) {
      return {
        success: false,
        error: `Invalid card structure: ${getCardValidationError(card)}`,
        message: `❌ Card validation failed. ${getCardValidationError(card)}`,
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Send the message
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const result = await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(card), parentMessageId);

    // Register action prompts if message was sent successfully
    if (result.messageId) {
      registerActionPrompts(result.messageId, chatId, actionPrompts);
      logger.info(
        { messageId: result.messageId, chatId, actions: Object.keys(actionPrompts) },
        'Interactive message sent and prompts registered'
      );
    }

    // Invoke message sent callback
    const callback = getMessageSentCallback();
    if (callback) {
      try {
        callback(chatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    return {
      success: true,
      message: `✅ Interactive message sent with ${Object.keys(actionPrompts).length} action(s)`,
      messageId: result.messageId,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_interactive_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send interactive message: ${errorMessage}` };
  }
}
