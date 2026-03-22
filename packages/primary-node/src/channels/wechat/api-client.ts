/**
 * WeChat ilink API Client.
 *
 * HTTP client for WeChat ilink bot API.
 * MVP v1: Only implements QR login and text message sending.
 *
 * @module channels/wechat/api-client
 */

import { createLogger } from '@disclaude/core';
import type {
  WeChatChannelConfig,
  ApiResponse,
  QRCodeResponse,
  QRCodeStatusResponse,
  SendMessageResponse,
  OutgoingTextPayload,
} from './types.js';

const logger = createLogger('WeChatApiClient');

/**
 * Default API endpoints.
 */
const ENDPOINTS = {
  GET_QRCODE: 'ilink/bot/get_bot_qrcode',
  GET_QRCODE_STATUS: 'ilink/bot/get_qrcode_status',
  SEND_MESSAGE: 'ilink/bot/sendmessage',
} as const;

/**
 * WeChat ilink API client.
 *
 * Provides methods to interact with WeChat ilink bot API:
 * - QR code login flow
 * - Text message sending
 */
export class WeChatApiClient {
  private readonly baseUrl: string;
  private readonly routeTag: string;
  private token?: string;

  constructor(config: WeChatChannelConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.routeTag = config.routeTag || 'default';
    this.token = config.token;

    logger.debug({ baseUrl: this.baseUrl, routeTag: this.routeTag }, 'API client created');
  }

  /**
   * Check if the client is authenticated.
   */
  isAuthenticated(): boolean {
    return !!this.token;
  }

  /**
   * Get the current token.
   */
  getToken(): string | undefined {
    return this.token;
  }

  /**
   * Set the authentication token.
   */
  setToken(token: string): void {
    this.token = token;
    logger.debug('Token updated');
  }

  /**
   * Build full URL for an endpoint.
   */
  private buildUrl(endpoint: string): string {
    return `${this.baseUrl}/${endpoint}`;
  }

  /**
   * Get authorization headers.
   */
  private getAuthHeaders(): Record<string, string> {
    if (!this.token) {
      return {};
    }
    return {
      Authorization: `Bearer ${this.token}`,
      AuthorizationType: 'ilink_bot_token',
    };
  }

  /**
   * Make a POST request to the API.
   */
  private async post<T>(
    endpoint: string,
    body?: Record<string, unknown>,
    requireAuth = false
  ): Promise<ApiResponse<T>> {
    if (requireAuth && !this.token) {
      throw new Error('Authentication required');
    }

    const url = this.buildUrl(endpoint);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
    };

    logger.debug({ endpoint, url, requireAuth }, 'Making API request');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ endpoint, status: response.status, body: text }, 'API request failed');
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as ApiResponse<T>;

      if (data.errcode !== 0) {
        logger.error({ endpoint, errcode: data.errcode, errmsg: data.errmsg }, 'API error');
        throw new Error(`API error: ${data.errmsg} (${data.errcode})`);
      }

      logger.debug({ endpoint }, 'API request successful');
      return data;
    } catch (error) {
      logger.error({ err: error, endpoint }, 'API request error');
      throw error;
    }
  }

  /**
   * Get QR code for login.
   *
   * @returns QR code response with URL and ID
   */
  async getQRCode(): Promise<QRCodeResponse> {
    const response = await this.post<QRCodeResponse>(ENDPOINTS.GET_QRCODE, {
      route_tag: this.routeTag,
    });

    if (!response.data) {
      throw new Error('No QR code data in response');
    }

    logger.info({ qrid: response.data.qrid }, 'QR code obtained');
    return response.data;
  }

  /**
   * Get QR code login status.
   *
   * @param qrid - QR code ID from getQRCode()
   * @returns Status response
   */
  async getQRCodeStatus(qrid: string): Promise<QRCodeStatusResponse> {
    const response = await this.post<QRCodeStatusResponse>(ENDPOINTS.GET_QRCODE_STATUS, {
      qrid,
      route_tag: this.routeTag,
    });

    if (!response.data) {
      throw new Error('No status data in response');
    }

    return response.data;
  }

  /**
   * Send a text message.
   *
   * @param chatId - Target chat ID (user open_id or group chat ID)
   * @param payload - Message payload
   * @returns Send message response with message ID
   */
  async sendMessage(
    chatId: string,
    payload: OutgoingTextPayload
  ): Promise<ApiResponse<SendMessageResponse>> {
    const response = await this.post<SendMessageResponse>(
      ENDPOINTS.SEND_MESSAGE,
      {
        to: chatId,
        ...payload,
      },
      true // Require auth
    );

    if (response.data) {
      logger.info({ chatId, msgid: response.data.msgid }, 'Message sent');
    }

    return response;
  }
}
