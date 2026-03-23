/**
 * WeChat Channel Implementation (MVP).
 *
 * Minimal channel implementation supporting:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 *
 * Not included in MVP (future issues):
 * - Message listening / long polling
 * - Media handling (CDN upload)
 * - CLI integration / config injection
 * - Unit tests
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 */

import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities } from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://api.weixin.qq.com';

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
  private readonly qrExpiration?: number;
  private client?: WeChatApiClient;
  private auth?: WeChatAuth;

  constructor(config: WeChatChannelConfig = {}) {
    super(config, 'wechat', 'WeChat');
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.routeTag = config.routeTag;
    this.qrExpiration = config.qrExpiration;
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
    this.auth = new WeChatAuth(this.client, {
      expiration: this.qrExpiration,
    });

    logger.info('Starting WeChat QR code authentication...');
    const result = await this.auth.authenticate();

    if (!result.success || !result.token) {
      throw new Error(`WeChat authentication failed: ${result.error || 'unknown error'}`);
    }

    this.client.setToken(result.token);
    logger.info(
      { botId: result.botId, userInfo: result.userInfo },
      'WeChat channel authenticated successfully'
    );
  }

  /**
   * Stop the WeChat channel.
   *
   * Aborts any in-progress authentication.
   */
  protected async doStop(): Promise<void> {
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
   * MVP: Only supports 'text' type messages.
   * Other types are logged as warnings and silently ignored.
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('WeChat client not initialized');
    }

    if (message.type === 'text' && message.text) {
      await this.client.sendText(message.chatId, message.text);
      return;
    }

    // MVP only supports text messages
    logger.warn(
      { type: message.type, chatId: message.chatId },
      'WeChat MVP only supports text messages, ignoring'
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
   * MVP capabilities: only send_text is supported.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: false,
      supportsMention: false,
      supportsUpdate: false,
      supportedMcpTools: ['send_text'],
    };
  }

  /**
   * Get the underlying API client (for testing/debugging).
   */
  getApiClient(): WeChatApiClient | undefined {
    return this.client;
  }
}
