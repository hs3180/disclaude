/**
 * send_message tool implementation.
 *
 * Issue #1035: Now supports IPC routing to PrimaryNode for unified LarkClientService.
 * Falls back to direct client creation if IPC is not available.
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
// Issue #1035: IPC routing for unified LarkClientService
import {
  isFeishuApiIpcAvailable,
  sendMessageViaIpc,
  sendCardViaIpc,
} from '../../ipc/feishu-api-client.js';

const logger = createLogger('SendMessage');

// Cache for IPC availability check
let ipcAvailable: boolean | null = null;
let ipcCheckTime = 0;
const IPC_CHECK_INTERVAL = 30000; // Re-check every 30 seconds

/**
 * Check if IPC is available, with caching.
 */
async function checkIpcAvailable(): Promise<boolean> {
  const now = Date.now();
  if (ipcAvailable !== null && now - ipcCheckTime < IPC_CHECK_INTERVAL) {
    return ipcAvailable;
  }

  ipcAvailable = await isFeishuApiIpcAvailable();
  ipcCheckTime = now;
  if (ipcAvailable) {
    logger.debug('IPC available for Feishu API requests');
  }
  return ipcAvailable;
}

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
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId, format }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Issue #1035: Try IPC first if available
    const useIpc = await checkIpcAvailable();

    if (format === 'text') {
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);

      if (useIpc) {
        // Use IPC to route through PrimaryNode's LarkClientService
        const result = await sendMessageViaIpc(chatId, textContent, parentMessageId);
        if (result.success) {
          logger.debug({ chatId, parentMessageId, via: 'IPC' }, 'User feedback sent (text)');
          invokeMessageSentCallback(chatId);
          return { success: true, message: `✅ Message sent (format: ${format})` };
        }
        logger.warn({ error: result.error }, 'IPC send failed, falling back to direct client');
      }

      // Fallback to direct client
      const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
      await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }), parentMessageId);
      logger.debug({ chatId, parentMessageId, via: 'direct' }, 'User feedback sent (text)');
    } else {
      // Card format
      let cardContent: Record<string, unknown>;

      if (typeof content === 'object' && isValidFeishuCard(content)) {
        cardContent = content;
      } else if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          if (isValidFeishuCard(parsed)) {
            cardContent = parsed;
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

      if (useIpc) {
        // Use IPC to route through PrimaryNode's LarkClientService
        const result = await sendCardViaIpc(chatId, cardContent, parentMessageId);
        if (result.success) {
          logger.debug({ chatId, parentMessageId, via: 'IPC' }, 'User card sent');
          invokeMessageSentCallback(chatId);
          return { success: true, message: `✅ Message sent (format: ${format})` };
        }
        logger.warn({ error: result.error }, 'IPC send failed, falling back to direct client');
      }

      // Fallback to direct client
      const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
      await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(cardContent), parentMessageId);
      logger.debug({ chatId, parentMessageId, via: 'direct' }, 'User card sent');
    }

    invokeMessageSentCallback(chatId);
    return { success: true, message: `✅ Message sent (format: ${format})` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send message: ${errorMessage}` };
  }
}
