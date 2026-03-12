/**
 * send_message tool implementation.
 *
 * @module mcp/tools/send-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { existsSync } from 'fs';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '@disclaude/primary-node';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { getIpcClient } from '../../ipc/unix-socket-client.js';
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
 * Send text message via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1088: Improved error handling with detailed error information.
 */
async function sendMessageViaIpc(
  chatId: string,
  text: string,
  threadId?: string
): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  return await ipcClient.feishuSendMessage(chatId, text, threadId);
}

/**
 * Send card message via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1088: Improved error handling with detailed error information.
 */
async function sendCardViaIpc(
  chatId: string,
  card: Record<string, unknown>,
  threadId?: string,
  description?: string
): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  return await ipcClient.feishuSendCard(chatId, card, threadId, description);
}

/**
 * Generate user-friendly error message based on IPC error type.
 * Issue #1088: Provide actionable error messages.
 */
function getIpcErrorMessage(errorType?: string, originalError?: string): string {
  switch (errorType) {
    case 'ipc_unavailable':
      return '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。';
    case 'ipc_timeout':
      return '❌ IPC 请求超时。服务可能过载，请稍后重试。';
    case 'ipc_request_failed':
      return `❌ IPC 请求失败: ${originalError ?? '未知错误'}`;
    default:
      return `❌ 消息发送失败: ${originalError ?? '未知错误'}`;
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
    const useIpc = isIpcAvailable();

    if (format === 'text') {
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);

      if (useIpc) {
        logger.debug({ chatId, parentMessageId }, 'Using IPC for text message');
        const result = await sendMessageViaIpc(chatId, textContent, parentMessageId);
        if (!result.success) {
          const errorMsg = getIpcErrorMessage(result.errorType, result.error);
          logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC text message failed');
          return {
            success: false,
            error: result.error ?? 'Failed to send message via IPC',
            message: errorMsg,
          };
        }
      } else {
        // Fallback: Create client directly
        const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
        await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }), parentMessageId);
      }
      logger.debug({ chatId, parentMessageId }, 'User feedback sent (text)');
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
        logger.debug({ chatId, parentMessageId }, 'Using IPC for card message');
        const result = await sendCardViaIpc(chatId, cardContent, parentMessageId);
        if (!result.success) {
          const errorMsg = getIpcErrorMessage(result.errorType, result.error);
          logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC card message failed');
          return {
            success: false,
            error: result.error ?? 'Failed to send card via IPC',
            message: errorMsg,
          };
        }
      } else {
        // Fallback: Create client directly
        const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(cardContent), parentMessageId);
      }
      logger.debug({ chatId, parentMessageId }, 'User card sent');
    }

    invokeMessageSentCallback(chatId);
    return { success: true, message: `✅ Message sent (format: ${format})` };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send message: ${errorMessage}` };
  }
}
