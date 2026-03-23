/**
 * WeChat API Client (MVP).
 *
 * HTTP client for interacting with the WeChat (Tencent ilink) Bot API.
 * Uses native fetch for zero external runtime dependencies.
 *
 * MVP API Endpoints:
 * - ilink/bot/get_bot_qrcode      - Generate login QR code
 * - ilink/bot/get_qrcode_status   - Poll login status
 * - ilink/bot/sendmessage         - Send a text message
 *
 * @module channels/wechat/api-client
 * @see Issue #1473 - WeChat Channel MVP
 */

import { createLogger } from '@disclaude/core';
import type { WeChatApiResponse } from './types.js';

const logger = createLogger('WeChatApiClient');

/** Request timeout for regular API calls (milliseconds). */
const API_TIMEOUT = 30000;

/**
 * WeChat API Client for Tencent ilink Bot API (MVP).
 *
 * Provides typed methods for auth and text messaging.
 * Uses Bearer token authentication with `AuthorizationType: ilink_bot_token`.
 */
export class WeChatApiClient {
  private readonly baseUrl: string;
  private token?: string;
  private readonly routeTag?: string;

  /**
   * Create a new WeChat API client.
   *
   * @param options - Client configuration
   */
  constructor(options: {
    /** API base URL (e.g., https://api.weixin.qq.com) */
    baseUrl: string;
    /** Bot token (set after authentication) */
    token?: string;
    /** Route tag for message routing */
    routeTag?: string;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.routeTag = options.routeTag;
  }

  /**
   * Set the bot token (called after successful authentication).
   */
  setToken(token: string): void {
    this.token = token;
    logger.info('Bot token updated');
  }

  /**
   * Get the current bot token.
   */
  getToken(): string | undefined {
    return this.token;
  }

  /**
   * Check if the client has a valid token.
   */
  hasToken(): boolean {
    return !!this.token;
  }

  /**
   * Generate a QR code for bot login.
   *
   * @returns QR code URL that the user should scan
   */
  async getBotQrCode(): Promise<string> {
    const response = await this.post<{ qrUrl: string }>('ilink/bot/get_bot_qrcode', {});
    if (!response.data?.qrUrl) {
      throw new Error('Failed to get QR code: no qrUrl in response');
    }
    logger.info('QR code generated successfully');
    return response.data.qrUrl;
  }

  /**
   * Poll the QR code login status.
   *
   * Status flow: 'wait' → 'scaned' → 'confirmed'
   *
   * @returns Current login status
   */
  async getQrCodeStatus(): Promise<{
    status: 'wait' | 'scaned' | 'confirmed' | 'expired';
    botToken?: string;
    botId?: string;
    userInfo?: { name: string; id: string };
  }> {
    const response = await this.post<{
      status: string;
      bot_token?: string;
      bot_id?: string;
      user_info?: { name: string; id: string };
    }>('ilink/bot/get_qrcode_status', {});

    const status = (response.data?.status || 'wait') as 'wait' | 'scaned' | 'confirmed' | 'expired';

    if (status === 'confirmed') {
      this.token = response.data?.bot_token;
      logger.info({ botId: response.data?.bot_id }, 'QR code login confirmed');
    }

    return {
      status,
      botToken: response.data?.bot_token,
      botId: response.data?.bot_id,
      userInfo: response.data?.user_info,
    };
  }

  /**
   * Send a text message.
   *
   * @param to - Target chat ID
   * @param content - Text content
   */
  async sendText(to: string, content: string): Promise<void> {
    await this.post('ilink/bot/sendmessage', {
      to,
      msgtype: 'text',
      text: { content },
    });
    logger.debug({ to, contentLength: content.length }, 'Text message sent');
  }

  /**
   * Make an authenticated POST request to the API.
   *
   * @param endpoint - API endpoint path (appended to baseUrl)
   * @param body - Request body
   * @returns Parsed API response
   */
  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<WeChatApiResponse<T>> {
    const url = `${this.baseUrl}/${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
      headers['AuthorizationType'] = 'ilink_bot_token';
    }

    if (this.routeTag) {
      headers['X-Route-Tag'] = this.routeTag;
    }

    logger.trace({ endpoint, bodyKeys: Object.keys(body) }, 'API request');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await response.json() as WeChatApiResponse<T>;

      if (!response.ok || !data.success) {
        const errorMsg = data.errorMsg || `HTTP ${response.status}`;
        const errorCode = data.errorCode || response.status;
        logger.error({ endpoint, errorCode, errorMsg }, 'API request failed');
        throw new Error(`WeChat API error [${errorCode}]: ${errorMsg}`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        logger.error({ endpoint }, 'API request timed out');
        throw new Error(`WeChat API timeout: ${endpoint}`);
      }

      throw error;
    }
  }
}
