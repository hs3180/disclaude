/**
 * WeChat Channel Implementation.
 *
 * WeChat (Tencent ilink) bot integration with:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Image/file sending via CDN upload (ilink/bot/upload)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.3: Media Handling)
 */

import { statSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Image file extensions for distinguishing images from other files. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

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
   * Supports:
   * - 'text': Text messages
   * - 'file': Images (via CDN upload) and files (via CDN upload)
   * - 'card': Downgraded to JSON-serialized text (WeChat API doesn't support cards)
   * - 'done': Task completion signal (no action)
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('WeChat client not initialized');
    }

    switch (message.type) {
      case 'text': {
        if (!message.text) {
          logger.warn({ chatId: message.chatId }, 'Text message with no content, ignoring');
          return;
        }
        await this.client.sendText({
          to: message.chatId,
          content: message.text,
          contextToken: message.threadId,
        });
        break;
      }

      case 'file': {
        if (!message.filePath) {
          logger.error({ chatId: message.chatId }, 'File path missing in file message');
          throw new Error('File path is required for file messages');
        }
        await this.sendFileMessage(message);
        break;
      }

      case 'card': {
        // WeChat doesn't support cards — downgrade to JSON-serialized text
        if (!message.card) {
          logger.warn({ chatId: message.chatId }, 'Card message with no card data, ignoring');
          return;
        }
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
        break;
      }

      case 'done':
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;

      default:
        logger.warn(
          { type: message.type, chatId: message.chatId },
          'Unsupported message type, ignoring'
        );
    }
  }

  /**
   * Send a file/image message.
   *
   * Uploads the file to WeChat CDN, then sends it as an image or file message
   * depending on the file extension.
   *
   * Issue #1556 Phase 3.3: Media Handling
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client || !message.filePath) {
      return;
    }

    const { filePath } = message;
    const fileName = basename(filePath);
    const ext = extname(filePath).toLowerCase();

    let fileSize: number;
    try {
      const stat = statSync(filePath);
      fileSize = stat.size;
    } catch {
      throw new Error(`File not found or not accessible: ${filePath}`);
    }

    logger.info({ chatId: message.chatId, filePath, fileName, fileSize }, 'Uploading media');

    const fileData = readFileSync(filePath);
    const mimeType = this.getMimeType(ext);

    // Upload to CDN
    const { url: cdnUrl } = await this.client.uploadMedia({
      fileData,
      fileName,
      mimeType,
    });

    // Send as image or file depending on extension
    if (IMAGE_EXTENSIONS.has(ext)) {
      await this.client.sendImage({
        to: message.chatId,
        imageUrl: cdnUrl,
        contextToken: message.threadId,
      });
      logger.info({ chatId: message.chatId, fileName }, 'Image message sent');
    } else {
      await this.client.sendFile({
        to: message.chatId,
        fileUrl: cdnUrl,
        fileName,
        contextToken: message.threadId,
      });
      logger.info({ chatId: message.chatId, fileName }, 'File message sent');
    }
  }

  /**
   * Get MIME type from file extension.
   */
  private getMimeType(ext: string): string {
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.tiff': 'image/tiff',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.zip': 'application/zip',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
    };
    return mimeMap[ext] ?? 'application/octet-stream';
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
   * Enhanced capabilities (Issue #1556 Phase 3.3):
   * - supportsFile: true (via CDN upload)
   * - supportedMcpTools: send_text, send_file
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
