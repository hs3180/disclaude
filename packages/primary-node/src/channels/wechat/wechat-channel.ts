/**
 * WeChat Channel Implementation.
 *
 * Channel implementation supporting:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Image and file sending (CDN upload via getuploadurl)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1475 - WeChat Channel Media Handling
 */

import * as path from 'node:path';
import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { WeChatMediaHandler } from './media-handler.js';
import { DEFAULT_CDN_BASE_URL } from './cdn.js';
import { MessageItemType } from './types.js';
import type { WeChatChannelConfig, MessageItem, CDNMedia } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/**
 * WeChat Channel.
 *
 * Provides WeChat (Tencent ilink) bot integration with:
 * - QR code authentication on start
 * - Text message sending
 * - Image and file sending via CDN upload
 *
 * Extends BaseChannel for lifecycle management and handler registration.
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly routeTag?: string;
  private client?: WeChatApiClient;
  private auth?: WeChatAuth;
  private mediaHandler?: WeChatMediaHandler;

  constructor(config: WeChatChannelConfig = {}) {
    super(config, 'wechat', 'WeChat');
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
    this.routeTag = config.routeTag;
  }

  /**
   * Start the WeChat channel.
   *
   * MVP flow:
   * 1. Create API client
   * 2. If no pre-configured token, run QR code auth
   * 3. Set token on client
   */
  protected async doStart(): Promise<void> {
    // Create API client
    this.client = new WeChatApiClient({
      baseUrl: this.baseUrl,
      token: this.config.token,
      routeTag: this.routeTag,
    });

    // Initialize media handler for file/image uploads
    this.mediaHandler = new WeChatMediaHandler(this.client, this.cdnBaseUrl);

    // If token is already configured, skip auth
    if (this.config.token) {
      logger.info('Using pre-configured bot token');
      return;
    }

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
      'WeChat channel authenticated successfully'
    );
  }

  /**
   * Stop the WeChat channel.
   *
   * Aborts any in-progress authentication.
   */
  protected doStop(): Promise<void> {
    if (this.auth?.isAuthenticating()) {
      this.auth.abort();
    }
    this.auth = undefined;
    this.client = undefined;
    this.mediaHandler = undefined;
    logger.info('WeChat channel stopped');
    return Promise.resolve();
  }

  /**
   * Send a message through the WeChat channel.
   *
   * Supports:
   * - 'text': Plain text messages
   * - 'file': Image and file messages (uploads to CDN first)
   * - 'done': Completion indicator (no-op)
   *
   * Other types are logged as warnings and silently ignored.
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('WeChat client not initialized');
    }

    // Text message
    if (message.type === 'text' && message.text) {
      await this.client.sendText({
        to: message.chatId,
        content: message.text,
        contextToken: message.threadId,
      });
      return;
    }

    // File / image message
    if (message.type === 'file' && message.filePath) {
      await this.sendFileMessage(message);
      return;
    }

    // Completion indicator (no-op)
    if (message.type === 'done') {
      return;
    }

    logger.warn(
      { type: message.type, chatId: message.chatId },
      'WeChat channel does not support this message type, ignoring',
    );
  }

  /**
   * Send a file or image message via CDN upload.
   *
   * Pipeline:
   * 1. Upload file to CDN (AES encrypted)
   * 2. Build appropriate message item (image or file)
   * 3. Send via sendmessage API
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    if (!this.mediaHandler || !this.client) {
      throw new Error('WeChat media handler not initialized');
    }

    const filePath = message.filePath!;
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const isImage = this.mediaHandler.isImageFile(extension);

    logger.info(
      { filePath, fileName, isImage, chatId: message.chatId },
      'Sending file message via CDN upload',
    );

    // Upload to CDN
    const uploaded = await this.mediaHandler.uploadFile(filePath, message.chatId);

    // Build CDN media reference
    const media: CDNMedia = {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
      encrypt_type: 1,
    };

    // Build message item based on type
    const item: MessageItem = isImage
      ? {
          type: MessageItemType.IMAGE,
          image_item: {
            media,
            mid_size: uploaded.fileSizeCiphertext,
          },
        }
      : {
          type: MessageItemType.FILE,
          file_item: {
            media,
            file_name: fileName,
            len: String(uploaded.fileSize),
          },
        };

    // Send message with optional text caption
    const items: MessageItem[] = [];
    if (message.text) {
      items.push({ type: MessageItemType.TEXT, text_item: { text: message.text } });
    }
    items.push(item);

    for (const msgItem of items) {
      await this.client.sendMediaItem({
        to: message.chatId,
        item: msgItem,
        contextToken: message.threadId,
      });
    }

    logger.info(
      { fileName, filekey: uploaded.filekey, chatId: message.chatId },
      'File message sent successfully',
    );
  }

  /**
   * Check if the WeChat channel is healthy.
   *
   * Returns true if the client has a valid token.
   */
  protected checkHealth(): boolean {
    return this.client?.hasToken() ?? false;
  }

  /**
   * Get the capabilities of the WeChat channel.
   *
   * Supports: text messages, file/image sending via CDN upload.
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
}
