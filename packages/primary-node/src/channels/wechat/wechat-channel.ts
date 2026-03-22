/**
 * WeChat Channel Implementation.
 *
 * Handles WeChat (Tencent ilink) bot messaging integration.
 * Implements the IChannel interface for unified message handling.
 *
 * Features:
 * - QR code based authentication
 * - Long polling message listener
 * - Text, image, and file message sending
 * - CDN-based media upload
 * - Message deduplication
 * - Health monitoring
 *
 * @see Issue #1406 - WeChat Channel support
 * @module channels/wechat/wechat-channel
 */

import { createLogger, BaseChannel, DEFAULT_CHANNEL_CAPABILITIES, type OutgoingMessage, type ChannelCapabilities, type IncomingMessage } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth, type AuthResult } from './auth.js';
import { WeChatMonitor } from './monitor.js';
import { WeChatMediaHandler } from './media-handler.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/**
 * WeChat Channel - Handles WeChat bot messaging.
 *
 * Lifecycle:
 * 1. doStart() → authenticate (QR login) → start message monitor
 * 2. doSendMessage() → convert OutgoingMessage → send via API
 * 3. doStop() → stop monitor → cleanup resources
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly pollingInterval: number;
  private readonly qrExpiration: number;

  private client?: WeChatApiClient;
  private auth?: WeChatAuth;
  private monitor?: WeChatMonitor;
  private mediaHandler?: WeChatMediaHandler;

  /** Last successful poll timestamp for health checks. */
  private lastPollActivity = 0;

  /** Health check staleness threshold (2x polling interval). */
  private get healthStalenessMs(): number {
    return (this.pollingInterval || 35000) * 2 + 30000;
  }

  /**
   * Create a new WeChat channel.
   *
   * @param config - WeChat channel configuration
   */
  constructor(config: WeChatChannelConfig = {}) {
    super(config, 'wechat', 'WeChat');

    this.baseUrl = config.baseUrl || process.env.WECHAT_API_BASE_URL || '';
    this.cdnBaseUrl = config.cdnBaseUrl || process.env.WECHAT_CDN_BASE_URL || '';
    this.pollingInterval = config.pollingInterval || 35000;
    this.qrExpiration = config.qrExpiration || 300;

    if (!this.baseUrl) {
      logger.warn('No baseUrl configured for WeChat channel. Set WECHAT_API_BASE_URL or config.channels.wechat.baseUrl');
    }
  }

  /**
   * Start the WeChat channel.
   *
   * Steps:
   * 1. Initialize API client
   * 2. Authenticate via QR code (if no token provided)
   * 3. Start message monitor for long polling
   */
  protected async doStart(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error('WeChat channel requires baseUrl configuration');
    }

    // Step 1: Initialize API client
    this.client = new WeChatApiClient({
      baseUrl: this.baseUrl,
      cdnBaseUrl: this.cdnBaseUrl,
      token: this.config.token,
      routeTag: this.config.routeTag,
    });

    this.mediaHandler = new WeChatMediaHandler(this.client);
    this.monitor = new WeChatMonitor(this.client, {
      pollTimeout: Math.floor(this.pollingInterval / 1000),
    });

    // Step 2: Authenticate (if no pre-configured token)
    if (this.config.token && this.client.hasToken()) {
      logger.info('Using pre-configured token');
    } else {
      logger.info('Starting QR code authentication flow');
      this.auth = new WeChatAuth(this.client, {
        expiration: this.qrExpiration,
      });

      const result: AuthResult = await this.auth.authenticate();

      if (!result.success || !result.token) {
        throw new Error(`Authentication failed: ${result.error || 'unknown error'}`);
      }

      logger.info({ botId: result.botId }, 'WeChat bot authenticated successfully');
    }

    // Step 3: Set up message handler and start monitoring
    this.monitor.onMessage(async (message: IncomingMessage) => {
      this.lastPollActivity = Date.now();
      await this.emitMessage(message);
    });

    this.monitor.start();
    logger.info('WeChatChannel started');
  }

  /**
   * Stop the WeChat channel.
   *
   * Gracefully shuts down the message monitor and cleans up resources.
   */
  protected async doStop(): Promise<void> {
    // Abort authentication if in progress
    if (this.auth?.isAuthenticating()) {
      this.auth.abort();
    }

    // Stop message monitor
    if (this.monitor) {
      await this.monitor.stop();
      this.monitor = undefined;
    }

    // Cleanup
    this.auth = undefined;
    this.mediaHandler = undefined;
    this.client = undefined;

    logger.info('WeChatChannel stopped');
  }

  /**
   * Send a message through the WeChat channel.
   *
   * Handles different message types:
   * - text: Plain text messages
   * - card: Sends as text (WeChat doesn't support rich cards)
   * - file: Uploads file to CDN, then sends file/image message
   * - done: Task completion signal (no-op)
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    switch (message.type) {
      case 'text': {
        await this.client.sendText(message.chatId, message.text || '');
        break;
      }

      case 'card': {
        // WeChat doesn't support interactive cards.
        // Convert card to plain text by extracting content from markdown elements.
        const cardText = this.extractTextFromCard(message.card);
        await this.client.sendText(message.chatId, cardText);
        logger.debug('Card converted to text (WeChat does not support cards)');
        break;
      }

      case 'file': {
        if (!message.filePath) {
          logger.error({ chatId: message.chatId }, 'File path missing in file message');
          throw new Error('File path is required for file messages');
        }

        await this.sendFile(message.chatId, message.filePath);
        break;
      }

      case 'done': {
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;
      }

      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Check if the WeChat channel is healthy.
   *
   * Health is determined by:
   * - Having an authenticated API client
   * - Monitor is actively polling
   * - Recent poll activity (within staleness threshold)
   */
  protected checkHealth(): boolean {
    if (!this.client?.hasToken()) {
      return false;
    }

    if (!this.monitor?.isPolling()) {
      return false;
    }

    // Check for recent activity (allow some slack for long polling intervals)
    if (this.lastPollActivity > 0) {
      return Date.now() - this.lastPollActivity < this.healthStalenessMs;
    }

    // If we just started and haven't polled yet, consider healthy
    return true;
  }

  /**
   * Get the capabilities of the WeChat channel.
   *
   * WeChat supports:
   * - File sending (images and documents)
   * - Text messages
   * - Mentions (@ in group chats)
   *
   * WeChat does NOT support:
   * - Interactive cards (converted to text)
   * - Threaded replies
   * - Markdown formatting
   * - Message updates
   */
  getCapabilities(): ChannelCapabilities {
    return {
      ...DEFAULT_CHANNEL_CAPABILITIES,
      supportsCard: false,      // WeChat doesn't support rich cards
      supportsThread: false,    // No native threading
      supportsFile: true,       // Supports image and file sending
      supportsMarkdown: false,  // No markdown rendering
      supportsMention: true,    // Supports @mentions in groups
      supportsUpdate: false,    // Cannot update sent messages
      supportedMcpTools: [
        'mcp__channel-mcp__send_text',
        'mcp__channel-mcp__send_file',
        // Note: send_card is not included as WeChat doesn't support cards
      ],
    };
  }

  /**
   * Send a file (image or document) through the WeChat channel.
   *
   * Uploads the file to CDN first, then sends the appropriate message type.
   */
  private async sendFile(chatId: string, filePath: string): Promise<void> {
    if (!this.mediaHandler) {
      throw new Error('Media handler not initialized');
    }

    const result = await this.mediaHandler.uploadFile(filePath);

    if (result.isImage) {
      if (!this.client) {
        throw new Error('Client not initialized');
      }
      await this.client.sendImage(chatId, result.cdnUrl);
      logger.info({ chatId, fileName: result.fileName }, 'Image message sent');
    } else {
      if (!this.client) {
        throw new Error('Client not initialized');
      }
      await this.client.sendFile(chatId, result.fileName, result.cdnUrl, result.fileSize);
      logger.info({ chatId, fileName: result.fileName, fileSize: result.fileSize }, 'File message sent');
    }
  }

  /**
   * Extract text content from a card structure.
   *
   * Handles common Feishu/Disclaude card formats:
   * - Simple text cards
   * - Cards with markdown elements
   *
   * @param card - Card structure (Record<string, unknown>)
   * @returns Extracted plain text
   */
  private extractTextFromCard(card?: Record<string, unknown>): string {
    if (!card) {
      return '';
    }

    // Try to extract from common card formats
    const content = card as Record<string, unknown>;

    // Format: { elements: [{ tag: 'markdown', content: '...' }] }
    if (Array.isArray(content.elements)) {
      const parts: string[] = [];
      for (const el of content.elements) {
        const element = el as Record<string, unknown>;
        if (element.tag === 'markdown' && typeof element.content === 'string') {
          parts.push(element.content);
        } else if (element.tag === 'div' && typeof element.text === 'object') {
          const textObj = element.text as Record<string, unknown>;
          if (typeof textObj.content === 'string') {
            parts.push(textObj.content);
          }
        }
      }
      return parts.join('\n');
    }

    // Format: { content: '...' }
    if (typeof content.content === 'string') {
      return content.content;
    }

    // Format: { text: '...' }
    if (typeof content.text === 'string') {
      return content.text;
    }

    // Fallback: stringify
    return JSON.stringify(content);
  }

  /**
   * Send a typing indicator to a chat.
   *
   * Can be called externally to show typing status before a response.
   *
   * @param chatId - Target chat ID
   */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.client || !this.isRunning) {
      return;
    }

    try {
      await this.client.sendTyping(chatId);
    } catch (error) {
      // Typing indicator is non-critical, log and continue
      logger.debug(
        { err: error instanceof Error ? error.message : String(error), chatId },
        'Failed to send typing indicator'
      );
    }
  }
}
