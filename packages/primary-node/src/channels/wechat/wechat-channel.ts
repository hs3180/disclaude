/**
 * WeChat Channel Implementation.
 *
 * WeChat (Tencent ilink) bot integration with:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Message listening via getUpdates long-poll (Issue #1556 Phase 3.1)
 * - Media handling via CDN upload (Issue #1556 Phase 3.2)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * Not yet implemented (future phases):
 * - Typing indicator — Issue #1556 Phase 3.2 (removed)
 * - Thread send support via context_token — Issue #1556 Phase 3.4 (postponed)
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities, type IncomingMessage } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { WeChatMessageListener, type MessageProcessor } from './message-listener.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Image file extensions. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico']);

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
   * Supports:
   * - 'text': Text messages
   * - 'card': Downgraded to JSON text
   * - 'file': Images/files (via CDN upload) — Issue #1556 Phase 3.2
   * - 'done': Task completion signal (no action)
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<string | void> {
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
        return;
      }

      case 'card': {
        // WeChat doesn't support cards — downgrade to JSON-serialized text
        if (message.card) {
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
        }
        return;
      }

      case 'file': {
        if (!message.filePath) {
          throw new Error('File path is required for file messages');
        }
        await this.sendFileMessage(message);
        return;
      }

      case 'done':
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        return;

      default:
        logger.warn(
          { type: message.type, chatId: message.chatId },
          'WeChat unsupported message type, ignoring'
        );
    }
  }

  /**
   * Send a file/image message.
   *
   * Uploads the file to WeChat CDN, then sends it as an image or file message.
   *
   * Issue #1556 Phase 3.2: Media Handling
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client || !message.filePath) {
      return;
    }

    const { filePath } = message;
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    logger.info({ chatId: message.chatId, filePath, fileName }, 'Uploading media');

    const fileData = fs.readFileSync(filePath);
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
    return mimeMap[ext] || 'application/octet-stream';
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
   * Enhanced capabilities (Issue #1556):
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

  /**
   * Get the message listener (for testing/debugging).
   */
  getMessageListener(): WeChatMessageListener | undefined {
    return this.messageListener;
  }
}
