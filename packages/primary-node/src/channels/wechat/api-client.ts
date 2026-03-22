/**
 * WeChat API Client.
 *
 * HTTP client for interacting with the WeChat (Tencent ilink) Bot API.
 * Uses native fetch for zero external runtime dependencies.
 *
 * API Endpoints:
 * - ilink/bot/get_bot_qrcode - Generate login QR code
 * - ilink/bot/get_qrcode_status - Poll login status
 * - ilink/bot/getupdates - Long poll for new messages
 * - ilink/bot/sendmessage - Send a message
 * - ilink/bot/getuploadurl - Get CDN upload URL
 * - ilink/bot/sendtyping - Send typing indicator
 *
 * @module channels/wechat/api-client
 */

import { createLogger } from '@disclaude/core';
import type { WeChatApiResponse } from './types.js';

const logger = createLogger('WeChatApiClient');

/** Default polling timeout for long polling requests (seconds). */
const LONG_POLL_TIMEOUT = 35;

/** Request timeout for regular API calls (milliseconds). */
const API_TIMEOUT = 30000;

/**
 * WeChat API Client for Tencent ilink Bot API.
 *
 * Provides typed methods for all API endpoints.
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
    /** CDN base URL (optional, derived from baseUrl if not provided) */
    cdnBaseUrl?: string;
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
   * Long poll for new messages.
   *
   * This is a blocking call that waits for new messages.
   * The server will hold the connection open until new messages arrive
   * or the timeout is reached.
   *
   * @param timeout - Polling timeout in seconds (default: 35)
   * @returns Array of new messages
   */
  async getUpdates(timeout: number = LONG_POLL_TIMEOUT): Promise<unknown[]> {
    const response = await this.post<{ updates: unknown[] }>('ilink/bot/getupdates', {
      timeout,
    });

    const updates = response.data?.updates || [];
    if (updates.length > 0) {
      logger.debug({ count: updates.length }, 'Received message updates');
    }

    return updates;
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
   * Send an image message.
   *
   * @param to - Target chat ID
   * @param cdnUrl - CDN URL of the uploaded image
   * @param options - Image options (width, height)
   */
  async sendImage(
    to: string,
    cdnUrl: string,
    options?: { width?: number; height?: number }
  ): Promise<void> {
    await this.post('ilink/bot/sendmessage', {
      to,
      msgtype: 'image',
      image: {
        cdnUrl,
        ...(options?.width && { width: options.width }),
        ...(options?.height && { height: options.height }),
      },
    });
    logger.debug({ to, cdnUrl }, 'Image message sent');
  }

  /**
   * Send a file message.
   *
   * @param to - Target chat ID
   * @param fileName - File name
   * @param cdnUrl - CDN URL of the uploaded file
   * @param fileSize - File size in bytes
   */
  async sendFile(to: string, fileName: string, cdnUrl: string, fileSize: number): Promise<void> {
    await this.post('ilink/bot/sendmessage', {
      to,
      msgtype: 'file',
      file: { fileName, cdnUrl, fileSize },
    });
    logger.debug({ to, fileName, fileSize }, 'File message sent');
  }

  /**
   * Get a CDN upload URL for media upload.
   *
   * @param fileName - File name for the upload
   * @param fileSize - File size in bytes
   * @returns Upload URL information
   */
  async getUploadUrl(fileName: string, fileSize: number): Promise<{
    uploadUrl: string;
    cdnUrl: string;
    expireSeconds: number;
  }> {
    const response = await this.post<{
      uploadUrl: string;
      cdnUrl: string;
      expire_seconds: number;
    }>('ilink/bot/getuploadurl', {
      fileName,
      fileSize,
    });

    if (!response.data?.uploadUrl) {
      throw new Error('Failed to get upload URL');
    }

    return {
      uploadUrl: response.data.uploadUrl,
      cdnUrl: response.data.cdnUrl,
      expireSeconds: response.data.expire_seconds || 3600,
    };
  }

  /**
   * Upload a file to CDN.
   *
   * @param uploadUrl - Upload URL obtained from getUploadUrl
   * @param fileBuffer - File content as Buffer
   * @param mimeType - MIME type of the file
   * @returns CDN URL of the uploaded file
   */
  async uploadToCdn(uploadUrl: string, fileBuffer: Buffer, mimeType: string): Promise<string> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileBuffer.length),
      },
      body: fileBuffer,
    });

    if (!response.ok) {
      throw new Error(`CDN upload failed: ${response.status} ${response.statusText}`);
    }

    // Extract CDN URL from response (varies by CDN provider)
    const result = await response.json().catch(() => null);
    const cdnUrl = (result as Record<string, unknown>)?.cdnUrl as string | undefined;
    if (!cdnUrl) {
      throw new Error('CDN upload succeeded but no CDN URL returned');
    }

    logger.debug({ cdnUrl }, 'File uploaded to CDN');
    return cdnUrl;
  }

  /**
   * Send a typing indicator to a chat.
   *
   * @param to - Target chat ID
   */
  async sendTyping(to: string): Promise<void> {
    await this.post('ilink/bot/sendtyping', { to });
    logger.debug({ to }, 'Typing indicator sent');
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
