/**
 * Feishu message sender utility for CLI mode.
 * Provides standalone message sending functionality without WebSocket.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { buildTextContent } from './content-builder.js';

/**
 * Create a Feishu message sender function.
 * This allows CLI mode to send messages via Feishu API without WebSocket.
 *
 * @returns Async function that sends messages to Feishu
 */
export function createFeishuSender(): (chatId: string, text: string) => Promise<void> {
  // Validate Feishu configuration
  const appId = Config.FEISHU_APP_ID;
  const appSecret = Config.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in environment variables');
  }

  // Create HTTP client (reused across calls)
  // Use Feishu domain for domestic services
  const client = new lark.Client({
    appId,
    appSecret,
    domain: lark.Domain.Feishu,
  });

  /**
   * Send a message to Feishu via REST API.
   * Uses plain text format for reliability.
   *
   * Note on Rich Text (post) Format:
   * According to official documentation, post format should work with:
   * {post: {zh_cn: {content: [[{tag: 'text', text: '...'}]]}}}
   * After extensive testing with different approaches (domain, content format, etc.),
   * the API still returns 230001 errors.
   * Plain text format is reliable and works consistently.
   *
   * Research sources:
   * - https://open.feishu.cn/document/server-docs/im-v1/message/create
   * - https://open.larksuite.com/document/ukTMukTMukTM/uMDMxEjLzATMx4yMwETM
   * - https://github.com/larksuite/node-sdk
   *
   * @param chatId - Target chat ID to send message to
   * @param text - Message content (plain text)
   */
  return async function sendMessage(chatId: string, text: string): Promise<void> {
    try {
      // Use plain text format (most reliable based on extensive testing)
      // Use content builder utility for consistent message formatting
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(text),
        },
      });

      // Log success (quiet mode - minimal output)
      const preview = text.substring(0, 50) + (text.length > 50 ? '...' : '');
      console.error(`[Feishu] Sent to ${chatId}: ${preview}`);
    } catch (error) {
      // Log error but don't crash
      console.error(`[Feishu Error] Failed to send message:`, error);
      throw error; // Re-throw to let caller handle it
    }
  };
}
