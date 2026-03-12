/**
 * Ruliu (如流) Message Sender Implementation.
 *
 * Implements IMessageSender interface for Ruliu platform.
 * Handles text and markdown messages via Ruliu API.
 *
 * @see https://qy.baidu.com/doc/index.html#/inner_serverapi/robot
 */

import type { Logger } from 'pino';
import type { IMessageSender } from '@disclaude/core';
import { handleError, ErrorCategory } from '../../utils/error-handler.js';
import { createLogger } from '../../utils/logger.js';
import { retry } from '../../utils/retry.js';
import type { RuliuConfig, RuliuApiResponse, RuliuMessageBodyItem } from './types.js';

/**
 * Ruliu Message Sender Configuration.
 */
export interface RuliuMessageSenderConfig {
  /** Ruliu configuration */
  config: RuliuConfig;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Ruliu API access token response.
 */
interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Ruliu Message Sender.
 *
 * Implements platform-agnostic IMessageSender interface for Ruliu.
 */
export class RuliuMessageSender implements IMessageSender {
  private config: RuliuConfig;
  private logger: Logger;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: RuliuMessageSenderConfig) {
    this.config = config.config;
    this.logger = config.logger ?? createLogger('RuliuMessageSender');
  }

  /**
   * Get access token for Ruliu API.
   * Tokens are cached and refreshed when expired.
   */
  private async getAccessToken(): Promise<string> {
    // Check if token is still valid
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    try {
      const response = await fetch(
        `${this.config.apiHost}/api/robot/v1/auth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            app_key: this.config.appKey,
            app_secret: this.config.appSecret,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as RuliuApiResponse<TokenResponse>;

      if (result.errcode !== 0) {
        throw new Error(`API error ${result.errcode}: ${result.errmsg}`);
      }

      this.accessToken = result.data!.access_token;
      // Expire 5 minutes before actual expiry
      this.tokenExpiresAt = Date.now() + (result.data!.expires_in - 300) * 1000;

      this.logger.debug({ expiresIn: result.data!.expires_in }, 'Access token obtained');
      return this.accessToken;
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to get access token');
      throw error;
    }
  }

  /**
   * Send message to Ruliu API.
   */
  private async sendMessage(
    chatId: string,
    body: RuliuMessageBodyItem[],
    threadId?: string
  ): Promise<void> {
    const token = await this.getAccessToken();

    // Build request body
    const requestBody: Record<string, unknown> = {
      chat_id: chatId,
      body,
    };

    // Add thread/reply info if provided
    if (threadId) {
      requestBody.parent_id = threadId;
    }

    try {
      const response = await retry(
        () => fetch(
          `${this.config.apiHost}/api/robot/v1/message/send`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(requestBody),
          }
        ),
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (attempt, error) => {
            this.logger.warn(
              { chatId, attempt, error: error.message },
              'Retrying sendMessage after failure'
            );
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as RuliuApiResponse;

      if (result.errcode !== 0) {
        throw new Error(`API error ${result.errcode}: ${result.errmsg}`);
      }

      this.logger.debug({ chatId, bodyType: body[0]?.type }, 'Message sent');
    } catch (error) {
      handleError(
        error,
        { category: ErrorCategory.API, chatId, messageType: 'ruliu' },
        { log: true, customLogger: this.logger }
      );
      throw error;
    }
  }

  /**
   * Send a text message.
   */
  async sendText(chatId: string, text: string, threadId?: string): Promise<void> {
    const body: RuliuMessageBodyItem[] = [
      { type: 'TEXT', content: text },
    ];
    await this.sendMessage(chatId, body, threadId);
  }

  /**
   * Send a card message (as Markdown in Ruliu).
   * Ruliu doesn't have native card support, so we use Markdown format.
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadId?: string
  ): Promise<void> {
    // Convert card to markdown representation
    let markdown = '';

    if (description) {
      markdown = `## ${description}\n\n`;
    }

    // Extract title from card header if present
    const header = card.header as Record<string, unknown> | undefined;
    if (header?.title) {
      const title = header.title as Record<string, unknown>;
      if (title.content) {
        markdown += `### ${title.content}\n\n`;
      }
    }

    // Extract elements
    const elements = card.elements as Array<Record<string, unknown>> | undefined;
    if (elements) {
      for (const element of elements) {
        if (element.tag === 'markdown' && element.content) {
          markdown += `${element.content}\n\n`;
        } else if (element.tag === 'div' && element.text) {
          const text = element.text as Record<string, unknown>;
          if (text.content) {
            markdown += `${text.content}\n\n`;
          }
        } else if (element.tag === 'hr') {
          markdown += '---\n\n';
        }
      }
    }

    // Fallback to JSON if no markdown extracted
    if (!markdown.trim()) {
      markdown = `\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``;
    }

    const body: RuliuMessageBodyItem[] = [
      { type: 'MD', content: markdown.trim() },
    ];
    await this.sendMessage(chatId, body, threadId);
  }

  /**
   * Send a file attachment.
   * Ruliu supports inline images via Base64.
   */
  async sendFile(chatId: string, filePath: string, threadId?: string): Promise<void> {
    // Note: Ruliu file sending requires different API
    // This is a placeholder - full implementation would need file upload API
    this.logger.warn(
      { chatId, filePath },
      'File sending not fully implemented for Ruliu'
    );

    // Send a text message indicating file would be sent
    const fileName = filePath.split('/').pop() || filePath;
    await this.sendText(
      chatId,
      `[File attachment: ${fileName}]\n\nFile sending requires additional API implementation.`,
      threadId
    );
  }

  /**
   * Add a reaction to a message.
   * Ruliu may not support reactions - this is a no-op.
   */
  addReaction(_messageId: string, _emoji: string): Promise<boolean> {
    this.logger.debug('Reactions not supported in Ruliu');
    return Promise.resolve(false);
  }
}
