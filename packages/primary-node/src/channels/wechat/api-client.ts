/**
 * WeChat API Client.
 *
 * Handles HTTP communication with WeChat ilink API.
 *
 * @module channels/wechat/api-client
 */

import { createLogger } from '@disclaude/core';
import type {
  WeChatChannelConfig,
  QRCodeResponse,
  QRCodeStatusResponse,
  OutgoingMessagePayload,
  SendMessageResponse,
  UploadUrlResponse,
  GetUpdatesResponse,
  WeChatApiError,
} from './types.js';

const logger = createLogger('WeChatApiClient');

/**
 * API response type helper.
 */
type ApiResponse<T> = { success: true; data: T } | { success: false; error: WeChatApiError };

/**
 * WeChat ilink API client.
 *
 * Provides methods for:
 * - QR code login flow
 * - Message sending (text, image, file)
 * - Long polling for incoming messages
 * - CDN file upload
 */
export class WeChatApiClient {
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private token: string | null = null;
  private botId: string | null = null;
  private readonly pollingTimeout: number;

  constructor(config: WeChatChannelConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.cdnBaseUrl = config.cdnBaseUrl || this.baseUrl;
    this.token = config.token || null;
    this.botId = config.botId || null;
    this.pollingTimeout = config.pollingTimeout || 35;
    logger.debug({ baseUrl: this.baseUrl }, 'WeChatApiClient created');
  }

  /**
   * Check if client is authenticated.
   */
  isAuthenticated(): boolean {
    return this.token !== null;
  }

  /**
   * Get current token.
   */
  getToken(): string | null {
    return this.token;
  }

  /**
   * Get current bot ID.
   */
  getBotId(): string | null {
    return this.botId;
  }

  /**
   * Set authentication credentials.
   */
  setCredentials(token: string, botId: string): void {
    this.token = token;
    this.botId = botId;
    logger.info({ botId }, 'Credentials set');
  }

  /**
   * Make HTTP request to API.
   */
  private async request<T>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      useCdn?: boolean;
    } = {}
  ): Promise<ApiResponse<T>> {
    const { method = 'GET', body, useCdn = false } = options;
    const baseUrl = useCdn ? this.cdnBaseUrl : this.baseUrl;
    const url = `${baseUrl}/${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authorization header if authenticated
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
      headers['AuthorizationType'] = 'ilink_bot_token';
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await response.json();

      if (!response.ok) {
        const error = data as WeChatApiError;
        logger.error({ endpoint, errcode: error.errcode, errmsg: error.errmsg }, 'API request failed');
        return { success: false, error };
      }

      return { success: true, data: data as T };
    } catch (err) {
      logger.error({ err, endpoint }, 'API request error');
      return {
        success: false,
        error: { errcode: -1, errmsg: err instanceof Error ? err.message : 'Unknown error' },
      };
    }
  }

  // ─── Authentication APIs ────────────────────────────────────────────────

  /**
   * Get QR code for login.
   *
   * Calls: ilink/bot/get_bot_qrcode
   */
  async getQRCode(): Promise<ApiResponse<QRCodeResponse>> {
    logger.info('Requesting QR code for login');
    return this.request<QRCodeResponse>('ilink/bot/get_bot_qrcode', { method: 'POST' });
  }

  /**
   * Get QR code scan status.
   *
   * Calls: ilink/bot/get_qrcode_status
   */
  async getQRCodeStatus(qrcodeId: string): Promise<ApiResponse<QRCodeStatusResponse>> {
    return this.request<QRCodeStatusResponse>('ilink/bot/get_qrcode_status', {
      method: 'POST',
      body: { qrcode_id: qrcodeId },
    });
  }

  // ─── Messaging APIs ──────────────────────────────────────────────────────

  /**
   * Send a message.
   *
   * Calls: ilink/bot/sendmessage
   */
  async sendMessage(
    chatId: string,
    payload: OutgoingMessagePayload
  ): Promise<ApiResponse<SendMessageResponse>> {
    if (!this.token) {
      return {
        success: false,
        error: { errcode: 401, errmsg: 'Not authenticated' },
      };
    }

    logger.debug({ chatId, msgtype: payload.msgtype }, 'Sending message');
    return this.request<SendMessageResponse>('ilink/bot/sendmessage', {
      method: 'POST',
      body: {
        to: chatId,
        ...payload,
      },
    });
  }

  /**
   * Send typing indicator.
   *
   * Calls: ilink/bot/sendtyping
   */
  async sendTyping(chatId: string): Promise<ApiResponse<void>> {
    if (!this.token) {
      return {
        success: false,
        error: { errcode: 401, errmsg: 'Not authenticated' },
      };
    }

    return this.request<void>('ilink/bot/sendtyping', {
      method: 'POST',
      body: { to: chatId },
    });
  }

  // ─── Long Polling APIs ───────────────────────────────────────────────────

  /**
   * Get updates via long polling.
   *
   * Calls: ilink/bot/getupdates
   */
  async getUpdates(timeout?: number): Promise<ApiResponse<GetUpdatesResponse>> {
    if (!this.token) {
      return {
        success: false,
        error: { errcode: 401, errmsg: 'Not authenticated' },
      };
    }

    const actualTimeout = timeout ?? this.pollingTimeout;
    return this.request<GetUpdatesResponse>(`ilink/bot/getupdates?timeout=${actualTimeout}`, {
      method: 'POST',
    });
  }

  // ─── CDN/File APIs ───────────────────────────────────────────────────────

  /**
   * Get upload URL for file.
   *
   * Calls: ilink/bot/getuploadurl
   */
  async getUploadUrl(fileName: string, fileSize: number): Promise<ApiResponse<UploadUrlResponse>> {
    if (!this.token) {
      return {
        success: false,
        error: { errcode: 401, errmsg: 'Not authenticated' },
      };
    }

    return this.request<UploadUrlResponse>('ilink/bot/getuploadurl', {
      method: 'POST',
      body: {
        file_name: fileName,
        file_size: fileSize,
      },
    });
  }

  /**
   * Upload file to CDN.
   *
   * Uses the upload URL from getUploadUrl.
   */
  async uploadFile(uploadUrl: string, file: Buffer | Blob, fileName: string): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('file', file, fileName);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        logger.error({ status: response.status }, 'File upload failed');
        return false;
      }

      logger.info({ fileName }, 'File uploaded successfully');
      return true;
    } catch (err) {
      logger.error({ err, fileName }, 'File upload error');
      return false;
    }
  }
}
