/**
 * WeChat Channel Implementation.
 *
 * Channel implementation supporting:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Image/file sending via CDN upload (ilink/bot/upload + sendmessage)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import type { WeChatChannelConfig } from './types.js';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/**
 * WeChat Channel implementation.
 *
 * Provides WeChat (Tencent ilink) bot integration with:
 * - QR code authentication on start
 * - Text message sending
 * - Image/file sending via CDN upload
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
   * For 'file' messages, the file is uploaded to WeChat CDN first, then sent
   * as an image or file message depending on the file extension.
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

    // File message: upload to CDN and send
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
   * Send a file/image message via CDN upload.
   *
   * 1. Read file from disk
   * 2. Upload to WeChat CDN
   * 3. Send as image (for image extensions) or file message
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('WeChat client not initialized');
    }

    const filePath = message.filePath ?? '';

    let fileData: Buffer;
    try {
      fileData = await readFile(filePath);
    } catch (error) {
      logger.error({ filePath, err: error }, 'Failed to read file for upload');
      throw new Error(`Failed to read file: ${filePath}`);
    }

    const fileName = filePath.split('/').pop() || 'unknown';
    const mimeType = getMimeType(fileName);

    // Upload to CDN
    const { url: cdnUrl } = await this.client.uploadMedia({
      fileData,
      fileName,
      mimeType,
    });

    // Send as image or file based on extension
    const ext = extname(fileName).toLowerCase();
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

    if (imageExtensions.has(ext)) {
      await this.client.sendImage({
        to: message.chatId,
        imageUrl: cdnUrl,
        contextToken: message.threadId,
      });
    } else {
      await this.client.sendFile({
        to: message.chatId,
        fileUrl: cdnUrl,
        fileName,
        contextToken: message.threadId,
      });
    }
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
   * Supports text and file (image/document) messaging.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get MIME type from file extension.
 *
 * Covers common image and document formats. Falls back to
 * 'application/octet-stream' for unknown extensions.
 */
function getMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return mimeMap[ext] || 'application/octet-stream';
}
