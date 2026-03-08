/**
 * Leave message tool implementation.
 *
 * This tool provides non-blocking interaction - Agent sends a message
 * and continues working. When the user replies, a new task is triggered.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp/tools/leave-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard as isValidCard, getCardValidationError } from '../utils/card-validator.js';
import { getMessageSentCallback } from './send-message.js';
import type { ActionPromptMap } from './types.js';

const logger = createLogger('LeaveMessage');

/**
 * Context for an offline message (non-blocking interaction).
 */
export interface OfflineMessageContext {
  /** Unique identifier for this offline message */
  id: string;
  /** The card message ID */
  messageId: string;
  /** Target chat ID */
  chatId: string;
  /** Action prompts for card interactions */
  actionPrompts: ActionPromptMap;
  /** Context about the original task */
  taskContext: string;
  /** Prompt template for the follow-up task */
  followUpPrompt: string;
  /** Creation timestamp */
  createdAt: number;
  /** Expiration timestamp (default: 7 days) */
  expiresAt: number;
}

/**
 * Result type for leave_message tool.
 */
export interface LeaveMessageResult {
  success: boolean;
  message: string;
  messageId?: string;
  offlineId?: string;
  error?: string;
}

/**
 * Store for offline message contexts.
 * Maps message ID to its context.
 */
const offlineContexts = new Map<string, OfflineMessageContext>();

/**
 * Default expiration time: 7 days in milliseconds.
 */
const DEFAULT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Generate a unique ID for offline messages.
 */
function generateOfflineId(): string {
  return `offline_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Register an offline message context.
 * Called after successfully sending an offline message.
 */
export function registerOfflineContext(context: Omit<OfflineMessageContext, 'id' | 'createdAt' | 'expiresAt'> & { expiresAt?: number }): OfflineMessageContext {
  const now = Date.now();
  const fullContext: OfflineMessageContext = {
    ...context,
    id: generateOfflineId(),
    createdAt: now,
    expiresAt: context.expiresAt ?? (now + DEFAULT_EXPIRATION_MS),
  };

  offlineContexts.set(context.messageId, fullContext);
  logger.info(
    { offlineId: fullContext.id, messageId: context.messageId, chatId: context.chatId },
    'Offline message context registered'
  );

  return fullContext;
}

/**
 * Get offline context by message ID.
 */
export function getOfflineContext(messageId: string): OfflineMessageContext | undefined {
  return offlineContexts.get(messageId);
}

/**
 * Remove offline context.
 */
export function unregisterOfflineContext(messageId: string): boolean {
  const removed = offlineContexts.delete(messageId);
  if (removed) {
    logger.debug({ messageId }, 'Offline context unregistered');
  }
  return removed;
}

/**
 * Generate a prompt from user's reply to an offline message.
 *
 * @param context - The offline message context
 * @param actionValue - The action value from the user's interaction
 * @param actionText - The display text of the action
 * @param formData - Form data if applicable
 * @returns The generated prompt for the follow-up task
 */
export function generateFollowUpPrompt(
  context: OfflineMessageContext,
  actionValue: string,
  actionText?: string,
  formData?: Record<string, unknown>
): string {
  // Get the action-specific prompt template if available
  let actionPrompt = context.actionPrompts[actionValue];

  if (actionPrompt) {
    // Replace placeholders
    if (actionText) {
      actionPrompt = actionPrompt.replace(/\{\{actionText\}\}/g, actionText);
    }
    actionPrompt = actionPrompt.replace(/\{\{actionValue\}\}/g, actionValue);

    if (formData) {
      for (const [key, value] of Object.entries(formData)) {
        const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
        actionPrompt = actionPrompt.replace(placeholder, String(value));
      }
    }
  } else {
    actionPrompt = `用户选择了「${actionText || actionValue}」`;
  }

  // Build the follow-up prompt
  const followUpPrompt = context.followUpPrompt
    .replace(/\{\{taskContext\}\}/g, context.taskContext)
    .replace(/\{\{actionPrompt\}\}/g, actionPrompt);

  return followUpPrompt;
}

/**
 * Cleanup expired offline contexts.
 */
export function cleanupExpiredOfflineContexts(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [messageId, context] of offlineContexts) {
    if (now > context.expiresAt) {
      offlineContexts.delete(messageId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug({ count: cleaned }, 'Cleaned up expired offline contexts');
  }

  return cleaned;
}

/**
 * Get all offline contexts (for debugging).
 */
export function getAllOfflineContexts(): OfflineMessageContext[] {
  return Array.from(offlineContexts.values());
}

/**
 * Send a non-blocking message for offline interaction.
 *
 * Unlike `send_interactive_message`, this tool:
 * 1. Does NOT block waiting for a response
 * 2. When user replies, triggers a NEW task (not resuming current task)
 * 3. Includes context about the original task
 *
 * @example
 * ```typescript
 * await leave_message({
 *   card: {
 *     config: { wide_screen_mode: true },
 *     header: { title: { tag: "plain_text", content: "需要您的反馈" } },
 *     elements: [
 *       { tag: "markdown", content: "关于代码重构方案..." },
 *       {
 *         tag: "action",
 *         actions: [
 *           { tag: "button", text: { tag: "plain_text", content: "同意" }, value: "agree" },
 *           { tag: "button", text: { tag: "plain_text", content: "反对" }, value: "disagree" }
 *         ]
 *       }
 *     ]
 *   },
 *   actionPrompts: {
 *     agree: "用户同意了重构方案。",
 *     disagree: "用户反对重构方案。"
 *   },
 *   taskContext: "代码重构方案讨论：将 utils 模块拆分为独立包",
 *   followUpPrompt: `
 * ## 背景
 * {{taskContext}}
 *
 * ## 用户反馈
 * {{actionPrompt}}
 *
 * ## 请执行
 * 根据用户的反馈，执行相应的后续操作。
 *   `,
 *   chatId: "oc_xxx"
 * });
 * ```
 */
export async function leave_message(params: {
  /** The interactive card JSON structure */
  card: Record<string, unknown>;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Context about the original task for reference */
  taskContext: string;
  /** Prompt template for the follow-up task. Supports {{taskContext}} and {{actionPrompt}} placeholders */
  followUpPrompt: string;
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
  /** Expiration time in milliseconds (default: 7 days) */
  expirationMs?: number;
}): Promise<LeaveMessageResult> {
  const { card, actionPrompts, taskContext, followUpPrompt, chatId, parentMessageId, expirationMs } = params;

  logger.info({
    chatId,
    actionCount: Object.keys(actionPrompts).length,
    hasParent: !!parentMessageId,
  }, 'leave_message called');

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
    if (!taskContext) {
      throw new Error('taskContext is required');
    }
    if (!followUpPrompt) {
      throw new Error('followUpPrompt is required');
    }

    // Validate card structure
    if (!isValidCard(card)) {
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

    // Register offline context if message was sent successfully
    if (result.messageId) {
      const context = registerOfflineContext({
        messageId: result.messageId,
        chatId,
        actionPrompts,
        taskContext,
        followUpPrompt,
        expiresAt: expirationMs ? Date.now() + expirationMs : undefined,
      });

      logger.info(
        { offlineId: context.id, messageId: result.messageId, chatId },
        'Offline message sent and context registered'
      );

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
        message: '✅ 离线留言已发送。用户回复后将触发新任务。',
        messageId: result.messageId,
        offlineId: context.id,
      };
    }

    return {
      success: false,
      error: 'Failed to get message ID from Feishu',
      message: '❌ 离线留言发送失败：无法获取消息ID',
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'leave_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 离线留言发送失败: ${errorMessage}` };
  }
}
