/**
 * send_message tool implementation.
 *
 * @module mcp/tools/send-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { getIpcClient } from '../../ipc/unix-socket-client.js';
import { existsSync } from 'fs';
import { DEFAULT_IPC_CONFIG } from '../../ipc/protocol.js';
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

/**
 * Check if IPC is available for Feishu API calls.
 * Issue #1035: Prefer IPC when available for unified client management.
 */
function isIpcAvailable(): boolean {
  return existsSync(DEFAULT_IPC_CONFIG.socketPath);
}

/**
 * Send message via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 */
async function sendMessageViaIpc(
  chatId: string,
  text: string,
  threadId?: string
): Promise<void> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.feishuSendMessage(chatId, text, threadId);
  if (!result.success) {
    throw new Error('Failed to send message via IPC');
  }
}

/**
 * Send card via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 */
async function sendCardViaIpc(
  chatId: string,
  card: Record<string, unknown>,
  threadId?: string,
  description?: string
): Promise<void> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.feishuSendCard(chatId, card, threadId, description);
  if (!result.success) {
    throw new Error('Failed to send card via IPC');
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

    // Issue #1035: Try IPC first if available
    const useIpc = isIpcAvailable();
    if (useIpc) {
      logger.debug({ chatId, format }, 'Using IPC for Feishu API call');
    }

    if (format === 'text') {
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);

      if (useIpc) {
        await sendMessageViaIpc(chatId, textContent, parentMessageId);
      } else {
        // Fallback: Create client directly
        const appId = Config.FEISHU_APP_ID;
        const appSecret = Config.FEISHU_APP_SECRET;
        if (!appId || !appSecret) {
          const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
          logger.error({ chatId, format }, errorMsg);
          return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
        }
        const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
        await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }), parentMessageId);
      }
      logger.debug({ chatId, parentMessageId, usedIpc: useIpc }, 'User feedback sent (text)');
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
        await sendCardViaIpc(chatId, cardContent, parentMessageId);
      } else {
        // Fallback: Create client directly
        const appId = Config.FEISHU_APP_ID;
        const appSecret = Config.FEISHU_APP_SECRET;
        if (!appId || !appSecret) {
          const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
          logger.error({ chatId, format }, errorMsg);
          return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
        }
        const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(cardContent), parentMessageId);
      }
      logger.debug({ chatId, parentMessageId, usedIpc: useIpc }, 'User card sent');
    }

    invokeMessageSentCallback(chatId);
    return { success: true, message: `✅ Message sent (format: ${format})` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send message: ${errorMessage}` };
  }
}
