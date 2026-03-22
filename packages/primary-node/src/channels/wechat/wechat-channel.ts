/**
 * WeChat Channel Implementation.
 *
 * Handles WeChat messaging platform integration via ilink API.
 * MVP v1: QR login + Token auth + Text messages only.
 *
 * @module channels/wechat/wechat-channel
 */

import {
  BaseChannel,
  createLogger,
  type ChannelCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
  type OutgoingMessage,
} from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuthHandler } from './auth.js';
import type { WeChatChannelConfig, WeChatChannelEvent } from './types.js';

const logger = createLogger('WeChatChannel');

/**
 * WeChat Channel - Handles WeChat messaging via ilink API.
 *
 * Features:
 * - QR code authentication (optional if token provided)
 * - Text message sending
 *
 * Limitations (MVP v1):
 * - No incoming message support (v2)
 * - No file/image support (v3)
 * - No card messages (WeChat limitation)
 *
 * @example
 * ```typescript
 * // With pre-configured token
 * const channel = new WeChatChannel({
 *   baseUrl: 'https://bot0.weidbot.qq.com',
 *   token: 'your-bot-token',
 *   botId: 'your-bot-id',
 * });
 * await channel.start();
 *
 * // With QR login
 * const channel = new WeChatChannel({
 *   baseUrl: 'https://bot0.weidbot.qq.com',
 * });
 * channel.on('qrcode', (event) => {
 *   console.log('Scan this QR code:', event.url);
 * });
 * await channel.start();
 * ```
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private apiClient: WeChatApiClient;
  private authHandler: WeChatAuthHandler;

  constructor(config: WeChatChannelConfig) {
    super(config, 'wechat', 'WeChat');

    // Initialize API client
    this.apiClient = new WeChatApiClient(config);

    // Initialize auth handler
    this.authHandler = new WeChatAuthHandler(this.apiClient, {
      timeout: config.loginTimeout,
      pollInterval: config.pollInterval,
    });

    // Forward auth events
    this.authHandler.on('qrcode', (event) => {
      this.emit('qrcode', event);
    });

    this.authHandler.on('authenticated', (creds) => {
      this.emit('authenticated', creds);
    });

    this.authHandler.on('error', (error) => {
      this.emit('error', error);
    });

    logger.info({ id: this.id }, 'WeChatChannel created');
  }

  /**
   * Start the channel.
   *
   * If token is provided in config, uses it directly.
   * Otherwise, starts QR code login flow.
   */
  protected async doStart(): Promise<void> {
    logger.info({ id: this.id }, 'Starting WeChatChannel');

    // Check if already authenticated via config
    if (this.apiClient.isAuthenticated()) {
      logger.info('Using pre-configured token');
      return;
    }

    // Start QR login flow
    logger.info('Starting QR login flow');
    await this.authHandler.startLogin();

    logger.info({ id: this.id }, 'WeChatChannel started');
  }

  /**
   * Stop the channel.
   */
  protected async doStop(): Promise<void> {
    logger.info({ id: this.id }, 'Stopping WeChatChannel');

    // Cancel any ongoing login
    this.authHandler.cancelLogin();

    logger.info({ id: this.id }, 'WeChatChannel stopped');
  }

  /**
   * Send a message through WeChat.
   *
   * MVP v1: Only supports text messages.
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.apiClient.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    switch (message.type) {
      case 'text': {
        await this.apiClient.sendMessage(message.chatId, {
          msgtype: 'text',
          text: { content: message.text || '' },
        });
        logger.debug({ chatId: message.chatId }, 'Text message sent');
        break;
      }

      case 'card':
        throw new Error('Card messages are not supported by WeChat');

      case 'file':
        throw new Error('File messages are not supported in MVP v1');

      case 'done':
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;

      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Check channel health.
   */
  protected checkHealth(): boolean {
    return this.apiClient.isAuthenticated();
  }

  /**
   * Get the capabilities of WeChat channel.
   *
   * MVP v1: Very limited capabilities.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      ...DEFAULT_CHANNEL_CAPABILITIES,
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: false,
      supportsMention: true,
      supportsUpdate: false,
      supportedMcpTools: ['send_text'],
    };
  }

  /**
   * Check if the channel is authenticated.
   */
  isAuthenticated(): boolean {
    return this.apiClient.isAuthenticated();
  }

  /**
   * Get current credentials (if authenticated).
   */
  getCredentials(): { token: string; botId: string } | undefined {
    return this.authHandler.getCredentials();
  }

  /**
   * Add event listener for WeChat-specific events.
   */
  override on<E extends WeChatChannelEvent>(
    event: E,
    listener: (...args: unknown[]) => void
  ): this {
    return super.on(event, listener);
  }

  /**
   * Remove event listener.
   */
  override off<E extends WeChatChannelEvent>(
    event: E,
    listener: (...args: unknown[]) => void
  ): this {
    return super.off(event, listener);
  }
}
