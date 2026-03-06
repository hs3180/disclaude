/**
 * send_message tool implementation.
 *
 * This tool sends messages to the configured messaging platform.
 * Currently supports Feishu/Lark platform with interactive cards.
 *
 * @module mcp/tools/send-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import type { SendMessageResult, MessageSentCallback } from './types.js';

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

export async function send_message(params: {
  content: string | Record<string, unknown>;
  format: 'text' | 'card';
  chatId: string;
  parentMessageId?: string;
}): Promise<SendMessageResult> {
  const { content, format, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    format,
    contentType: typeof content,
    contentPreview: typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100),
  }, 'send_message called');

  try {
    if (!content) { throw new Error('content is required'); }
    if (!format) { throw new Error('format is required (must be "text" or "card")'); }
    if (!chatId) { throw new Error('chatId is required'); }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Messaging platform credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId, format }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    if (format === 'text') {
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);
      await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }), parentMessageId);
      logger.debug({ chatId, parentMessageId }, 'Message sent (text)');
    } else {
      if (typeof content === 'object' && isValidFeishuCard(content)) {
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(content), parentMessageId);
        logger.debug({ chatId, parentMessageId }, 'Card message sent');
      } else if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          if (isValidFeishuCard(parsed)) {
            await sendMessageToFeishu(client, chatId, 'interactive', content, parentMessageId);
          } else {
            return {
              success: false,
              error: `Invalid card structure: ${getCardValidationError(parsed)}`,
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

    invokeMessageSentCallback(chatId);
    return { success: true, message: `✅ Message sent (format: ${format})` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send message: ${errorMessage}` };
  }
}

/**
 * @deprecated Use send_message instead. Will be removed in a future version.
 */
export const send_user_feedback = send_message;
