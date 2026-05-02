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
 * - Typing indicator — Issue #1556 Phase 3.2
 * - Thread send support via context_token — Issue #1556 Phase 3.4
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities, type IncomingMessage } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { WeChatMessageListener, type MessageProcessor } from './message-listener.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

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
   * - 'card': Downgraded to JSON-serialized text (WeChat doesn't support cards)
   * - 'file': Upload via CDN and send as image or file (Issue #1556 Phase 3.2)
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
        'Card downgraded to text for WeChat MVP'
      );
      return;
    }

    // File/image sending via CDN upload (Issue #1556 Phase 3.2)
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
   * Upload a local file to CDN and send as image or file message.
   *
   * Auto-detects whether to use sendImage or sendFile based on file extension.
   */
  private async sendFileMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client || !message.filePath) {
      return;
    }

    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const fileName = path.basename(message.filePath);

    // Read file data
    const fileData = await fs.readFile(message.filePath);

    // Upload to CDN
    const { url } = await this.client.uploadMedia({
      fileData,
      fileName,
    });

    // Determine if it's an image or generic file
    const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const isImage = imageExtensions.has(ext);

    if (isImage) {
      await this.client.sendImage({
        to: message.chatId,
        imageUrl: url,
        contextToken: message.threadId,
      });
      logger.debug({ chatId: message.chatId, fileName }, 'Image file sent via CDN');
    } else {
      await this.client.sendFile({
        to: message.chatId,
        fileUrl: url,
        fileName,
        contextToken: message.threadId,
      });
      logger.debug({ chatId: message.chatId, fileName }, 'File sent via CDN');
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
   * Supports text and file (image/attachment via CDN upload) sending.
   * Cards are downgraded to JSON text (not native card support).
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
