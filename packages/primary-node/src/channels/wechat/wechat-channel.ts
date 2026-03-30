/**
 * WeChat Channel Implementation.
 *
 * Channel implementation supporting:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Image and file sending via CDN upload (ilink/bot/upload)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/**
 * WeChat Channel - MVP implementation.
 *
 * Provides WeChat (Tencent ilink) bot integration with:
 * - QR code authentication on start
 * - Text message sending
 *
 * Extends BaseChannel for lifecycle management and handler registration.
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private readonly baseUrl: string;
  private readonly routeTag?: string;
  private client?: WeChatApiClient;
  private auth?: WeChatAuth;

  constructor(config: WeChatChannelConfig = {}) {
    super(config, 'wechat', 'WeChat');
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
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
    logger.info('WeChat channel stopped');
    return Promise.resolve();
  }

  /**
   * Send a message through the WeChat channel.
   *
   * Supports 'text', 'card' (downgraded to JSON text), and 'file' types.
   * Other types are logged as warnings and silently ignored.
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
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

    // File/image sending: upload to CDN then send
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
   * Send a file or image message.
   *
   * 1. Read file from local filesystem
   * 2. Upload to WeChat CDN
   * 3. Send as image or file message depending on extension
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    const filePath = message.filePath!;
    const fileName = path.basename(filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileData = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isImage = WeChatChannel.IMAGE_EXTENSIONS.includes(ext);

    logger.info(
      { chatId: message.chatId, filePath, fileName, size: fileData.length, isImage },
      'Uploading file to WeChat CDN',
    );

    const { url: cdnUrl } = await this.client!.uploadMedia({
      fileData,
      fileName,
    });

    if (isImage) {
      await this.client!.sendImage({
        to: message.chatId,
        imageUrl: cdnUrl,
        contextToken: message.threadId,
      });
    } else {
      await this.client!.sendFile({
        to: message.chatId,
        fileUrl: cdnUrl,
        fileName,
        contextToken: message.threadId,
      });
    }

    logger.info(
      { chatId: message.chatId, fileName, cdnUrl },
      `${isImage ? 'Image' : 'File'} message sent`,
    );
  }

  /** Supported image file extensions. */
  private static readonly IMAGE_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
  ];

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
   * Supports send_text and send_file (image + document upload via CDN).
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
