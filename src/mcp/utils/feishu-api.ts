/**
 * Feishu API utilities for MCP tools.
 *
 * This module provides low-level API functions for interacting with Feishu.
 * Handles message sending, client creation, and other common API operations.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';

const logger = createLogger('FeishuApi');

/**
 * Internal helper: Send a message to Feishu chat.
 *
 * Handles the common logic for sending messages to Feishu API.
 * Supports thread replies via parent_id parameter.
 *
 * @param client - Lark client instance
 * @param chatId - Feishu chat ID
 * @param msgType - Message type ('text' or 'interactive')
 * @param content - Message content (JSON stringified)
 * @param parentId - Optional parent message ID for thread replies
 * @throws Error if sending fails
 */
export async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
  parentId?: string
): Promise<void> {
  const messageData: {
    receive_id_type?: string;
    msg_type: string;
    content: string;
  } = {
    msg_type: msgType,
    content,
  };

  // When replying to a message, use reply method to properly quote the user's message
  if (parentId) {
    await client.im.message.reply({
      path: {
        message_id: parentId,
      },
      data: messageData,
    });
  } else {
    // New message: use create method with receive_id
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        ...messageData,
      },
    });
  }
}

/**
 * Update an existing card message in Feishu.
 *
 * @param client - Lark client instance
 * @param messageId - The message ID to update
 * @param cardContent - The new card content (JSON stringified)
 */
export async function updateCardMessage(
  client: lark.Client,
  messageId: string,
  cardContent: string
): Promise<void> {
  await client.im.message.patch({
    path: {
      message_id: messageId,
    },
    data: {
      content: cardContent,
    },
  });
}

/**
 * Create a Feishu client with standard configuration.
 *
 * @param appId - Feishu app ID
 * @param appSecret - Feishu app secret
 * @returns Configured Lark client instance
 */
export function createClient(appId: string, appSecret: string): lark.Client {
  return createFeishuClient(appId, appSecret, {
    domain: lark.Domain.Feishu,
  });
}

/**
 * Notify the message sent callback if set.
 *
 * @param callback - The callback function (or null)
 * @param chatId - The chat ID that received the message
 */
export function notifyMessageSent(
  callback: ((chatId: string) => void) | null,
  chatId: string
): void {
  if (callback) {
    try {
      callback(chatId);
    } catch (error) {
      logger.error({ err: error }, 'Failed to invoke message sent callback');
    }
  }
}
