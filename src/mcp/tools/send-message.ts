/**
 * send_user_feedback tool implementation.
 *
 * @module mcp/tools/send-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import type { SendFeedbackResult, MessageSentCallback } from './types.js';

const logger = createLogger('SendMessage');

let messageSentCallback: MessageSentCallback | null = null;

export function setMessageSentCallback(callback: MessageSentCallback | null): void {
  messageSentCallback = callback;
}

export function getMessageSentCallback(): MessageSentCallback | null {
  return messageSentCallback;
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

export async function send_user_feedback(params: {
  content: string | Record<string, unknown>;
  format: 'text' | 'card';
  chatId: string;
  parentMessageId?: string;
}): Promise<SendFeedbackResult> {
  const { content, format, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    format,
    contentType: typeof content,
    contentPreview: typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100),
  }, 'send_user_feedback called');

  try {
    if (!content) { throw new Error('content is required'); }
    if (!format) { throw new Error('format is required (must be "text" or "card")'); }
    if (!chatId) { throw new Error('chatId is required'); }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId, format }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    if (format === 'text') {
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);
      const result = await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }), parentMessageId);
      logger.debug({ chatId, parentMessageId, messageId: result.messageId }, 'User feedback sent (text)');
      invokeMessageSentCallback(chatId);
      return { success: true, message: `✅ Feedback sent (format: ${format})`, messageId: result.messageId };
    } else {
      if (typeof content === 'object' && isValidFeishuCard(content)) {
        const result = await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(content), parentMessageId);
        logger.debug({ chatId, parentMessageId, messageId: result.messageId }, 'User card sent');
        invokeMessageSentCallback(chatId);
        return { success: true, message: `✅ Feedback sent (format: ${format})`, messageId: result.messageId };
      } else if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          if (isValidFeishuCard(parsed)) {
            const result = await sendMessageToFeishu(client, chatId, 'interactive', content, parentMessageId);
            invokeMessageSentCallback(chatId);
            return { success: true, message: `✅ Feedback sent (format: ${format})`, messageId: result.messageId };
          } else {
            return {
              success: false,
              error: `Invalid Feishu card structure: ${getCardValidationError(parsed)}`,
              message: `❌ Card validation failed. ${getCardValidationError(parsed)}.`,
            };
          }
        } catch (parseError) {
          return {
            success: false,
            error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Parse failed'}`,
            message: '❌ Content is not valid JSON.',
          };
        }
      } else {
        const actualType = content === null ? 'null' : typeof content;
        return {
          success: false,
          error: `Invalid content type: expected object or string, got ${actualType}`,
          message: '❌ Invalid content type.',
        };
      }
    }

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_user_feedback FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send feedback: ${errorMessage}` };
  }
}
