/**
 * WeChat Channel Implementation.
 *
 * WeChat (Tencent ilink) bot integration with:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Image and file sending via CDN upload (Issue #1556 Phase 3.2)
 * - Message listening via getUpdates long-poll (Issue #1556 Phase 3.1)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * Not yet implemented (future phases):
 * - Typing indicator — Issue #1556 Phase 3.2 (removed from scope)
 * - Thread send support via context_token — Issue #1556 Phase 3.4 (removed from scope)
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities, type IncomingMessage } from '@disclaude/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { WeChatMessageListener, type MessageProcessor } from './message-listener.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Image file extensions for auto-detecting image vs file messages. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg']);

/**
 * Determine if a file is an image based on its extension.
 */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * WeChat Channel.
 *
 * Provides WeChat (Tencent ilink) bot integration with:
 * - QR code authentication on start
 * - Text message sending
 * - Long-poll message listening
 *
 * Extends BaseChannel for lifecycle management and handler registration.
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private readonly baseUrl: string;
  private readonly routeTag?: string;
  private client?: WeChatApiClient;
  private auth?: WeChatAuth;
  private messageListener?: WeChatMessageListener;

  constructor(config: WeChatChannelConfig = {}) {
    super(config, 'wechat', 'WeChat');
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.routeTag = config.routeTag;
  }

  /**
   * Start the WeChat channel.
   *
   * Flow:
   * 1. Create API client
   * 2. If no pre-configured token, run QR code auth
   * 3. Set token on client
   * 4. Start message listener (Issue #1556 Phase 3.1)
   */
  protected async doStart(): Promise<void> {
    // Create API client
    this.client = new WeChatApiClient({
      baseUrl: this.baseUrl,
      token: this.config.token,
      routeTag: this.routeTag,
    });

    // If token is already configured, skip auth
    if (this.config.token) {
      logger.info('Using pre-configured bot token');
    } else {
      // Run QR code authentication
      this.auth = new WeChatAuth(this.client);

      logger.info('Starting WeChat QR code authentication...');
      const result = await this.auth.authenticate();

      if (!result.success || !result.token) {
        throw new Error(`WeChat authentication failed: ${result.error || 'unknown error'}`);
      }

      this.client.setToken(result.token);
      logger.info(
        { botId: result.botId, userId: result.userId },
        'WeChat channel authenticated successfully',
      );
    }

    // Start message listener (Issue #1556 Phase 3.1)
    const processor: MessageProcessor = async (message: IncomingMessage) => {
      await this.emitMessage(message);
    };

    this.messageListener = new WeChatMessageListener(this.client, processor);
    this.messageListener.start();

    logger.info('WeChat channel started with message listening');
  }

  /**
   * Stop the WeChat channel.
   *
   * Stops message listener and aborts any in-progress authentication.
   */
  protected async doStop(): Promise<void> {
    // Stop message listener first
    if (this.messageListener) {
      await this.messageListener.stop();
      this.messageListener = undefined;
    }

    if (this.auth?.isAuthenticating()) {
      this.auth.abort();
    }
    this.auth = undefined;
    this.client = undefined;
    logger.info('WeChat channel stopped');
  }

  /**
   * Send a message through the WeChat channel.
   *
   * Supports 'text', 'card' (downgraded to JSON text), and 'file' types.
   * File messages are uploaded to WeChat CDN and sent as image/file messages.
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<string | void> {
    if (!this.client) {
      throw new Error('WeChat client not initialized');
    }

    if (message.type === 'text' && message.text) {
      await this.client.sendText({
        to: message.chatId,
        content: message.text,
        contextToken: message.threadId,
      });
      return;
    }

    // WeChat doesn't support cards — downgrade to JSON-serialized text
    if (message.type === 'card' && message.card) {
      const cardText = JSON.stringify(message.card);
      await this.client.sendText({
        to: message.chatId,
        content: cardText,
        contextToken: message.threadId,
      });
      logger.debug(
        { chatId: message.chatId, cardLength: cardText.length },
        'Card downgraded to text for WeChat'
      );
      return;
    }

    // File message: upload to CDN and send as image or file
    if (message.type === 'file' && message.filePath) {
      await this.sendFileMessage(message);
      return;
    }

    // Unsupported message types
    logger.warn(
      { type: message.type, chatId: message.chatId },
      'WeChat unsupported message type, ignoring'
    );
  }

  /**
   * Upload a file to CDN and send as image or file message.
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client || !message.filePath) return;

    const filePath = message.filePath;
    const fileName = path.basename(filePath);

    // Read file from disk
    let fileData: Buffer;
    try {
      fileData = await fs.promises.readFile(filePath);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), filePath },
        'Failed to read file for upload'
      );
      throw new Error(`Failed to read file: ${filePath}`);
    }

    // Upload to WeChat CDN
    const mimeType = guessMimeType(filePath);
    const uploadResult = await this.client.uploadMedia({
      fileData,
      fileName,
      mimeType,
    });

    // Send as image or file based on extension
    if (isImageFile(filePath)) {
      await this.client.sendImage({
        to: message.chatId,
        imageUrl: uploadResult.url,
        contextToken: message.threadId,
      });
      logger.debug(
        { chatId: message.chatId, fileName, imageUrl: uploadResult.url },
        'Image sent via CDN'
      );
    } else {
      await this.client.sendFile({
        to: message.chatId,
        fileUrl: uploadResult.url,
        fileName,
        contextToken: message.threadId,
      });
      logger.debug(
        { chatId: message.chatId, fileName, fileUrl: uploadResult.url },
        'File sent via CDN'
      );
    }
  }

  /**
   * Check if the WeChat channel is healthy.
   *
   * Returns true if the client has a valid token and message listener is active.
   */
  protected checkHealth(): boolean {
    return (this.client?.hasToken() ?? false) && this.messageListener?.isListening() === true;
  }

  /**
   * Get the capabilities of the WeChat channel.
   *
   * Supports text messaging and file/image sending via CDN upload.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsCard: false,
      supportsThread: false,
      supportsFile: true,
      supportsMarkdown: false,
      supportsMention: false,
      supportsUpdate: false,
      supportedMcpTools: ['send_text', 'send_file'],
    };
  }

  /**
   * Get the underlying API client (for testing/debugging).
   */
  getApiClient(): WeChatApiClient | undefined {
    return this.client;
  }

  /**
   * Get the message listener (for testing/debugging).
   */
  getMessageListener(): WeChatMessageListener | undefined {
    return this.messageListener;
  }
}
