/**
 * WeChat API Client.
 *
 * HTTP client for interacting with the WeChat (Tencent ilink) Bot API.
 * Uses native fetch for zero external runtime dependencies.
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * API Endpoints:
 * - GET  ilink/bot/get_bot_qrcode      - Generate login QR code
 * - GET  ilink/bot/get_qrcode_status   - Long-poll QR login status (35s)
 * - POST ilink/bot/sendmessage         - Send a message (text, image, file)
 * - POST ilink/bot/uploadmedia         - Upload media file (CDN)
 * - POST ilink/bot/getupdates          - Long-poll for incoming messages
 *
 * @module channels/wechat/api-client
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap (Phase 3.2)
 */

import { createLogger } from '@disclaude/core';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const logger = createLogger('WeChatApiClient');

/** Default timeout for regular API requests (milliseconds). */
const DEFAULT_API_TIMEOUT_MS = 15_000;

/** Timeout for file upload requests (milliseconds). */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Long-poll timeout for QR status / getUpdates (milliseconds). */
const LONG_POLL_TIMEOUT_MS = 35_000;

/** Default bot type for QR code generation. */
const DEFAULT_BOT_TYPE = 3;

/** Maximum file size for image uploads (10 MB). */
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum file size for file uploads (30 MB). */
const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;

/** Image file extensions recognized by WeChat CDN. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.ico',
]);

/**
 * Media type for CDN upload.
 */
export type MediaType = 'image' | 'file';

/**
 * Result of a media upload operation.
 */
export interface MediaUploadResult {
  /** Media ID returned by CDN, used to reference the uploaded file */
  mediaId: string;
  /** Media type that was uploaded */
  mediaType: MediaType;
}

/**
 * WeChat API Client for Tencent ilink Bot API.
 *
 * Provides typed methods for auth, text messaging, and media handling.
 * Uses Bearer token authentication with `AuthorizationType: ilink_bot_token`.
 */
export class WeChatApiClient {
  private readonly baseUrl: string;
  private token?: string;
  private readonly routeTag?: string;
  private readonly botType: number;

  /**
   * Create a new WeChat API client.
   *
   * @param options - Client configuration
   */
  constructor(options: {
    /** API base URL (default: https://ilinkai.weixin.qq.com) */
    baseUrl: string;
    /** Bot token (set after authentication) */
    token?: string;
    /** Route tag for message routing */
    routeTag?: string;
    /** Bot type for QR code generation (default: 3) */
    botType?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.routeTag = options.routeTag;
    this.botType = options.botType ?? DEFAULT_BOT_TYPE;
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

  // ---------------------------------------------------------------------------
  // Auth endpoints (GET, no auth headers)
  // ---------------------------------------------------------------------------

  /**
   * Generate a QR code for bot login.
   *
   * GET /ilink/bot/get_bot_qrcode?bot_type=3
   *
   * @returns QR code data including URL and identifier
   */
  async getBotQrCode(): Promise<{ qrcode: string; qrUrl: string }> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${this.botType}`;
    logger.info({ url }, 'Fetching QR code');

    const headers: Record<string, string> = {};
    if (this.routeTag) {
      headers['SKRouteTag'] = this.routeTag;
    }

    const response = await this.fetchJson<{ qrcode?: string; qrcode_img_content?: string }>(url, { method: 'GET', headers });

    // eslint-disable-next-line eqeqeq -- intentional nullish check (null || undefined)
    if (response.qrcode == null || response.qrcode_img_content == null) {
      throw new Error('Failed to get QR code: missing fields in response');
    }

    logger.info('QR code generated successfully');
    return { qrcode: response.qrcode, qrUrl: response.qrcode_img_content };
  }

  /**
   * Poll the QR code login status (long polling, 35s timeout).
   *
   * GET /ilink/bot/get_qrcode_status?qrcode=xxx
   *
   * On client-side timeout, returns 'wait' status (normal for long polling).
   *
   * @param qrcode - QR code identifier from getBotQrCode
   * @returns Current login status
   */
  async getQrCodeStatus(qrcode: string): Promise<{
    status: 'wait' | 'scaned' | 'confirmed' | 'expired';
    botToken?: string;
    botId?: string;
    userId?: string;
    baseUrl?: string;
  }> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;

    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
    };
    if (this.routeTag) {
      headers['SKRouteTag'] = this.routeTag;
    }

    try {
      const data = await this.fetchJson<{
        status?: string;
        bot_token?: string;
        ilink_bot_id?: string;
        ilink_user_id?: string;
        baseurl?: string;
      }>(url, { method: 'GET', headers, timeoutMs: LONG_POLL_TIMEOUT_MS });

      const status = (data.status || 'wait') as 'wait' | 'scaned' | 'confirmed' | 'expired';

      if (status === 'confirmed') {
        this.token = data.bot_token;
        logger.info({ botId: data.ilink_bot_id }, 'QR code login confirmed');
      }

      return {
        status,
        botToken: data.bot_token,
        botId: data.ilink_bot_id,
        userId: data.ilink_user_id,
        baseUrl: data.baseurl,
      };
    } catch (error) {
      // Timeout during long polling is normal — treat as 'wait'
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('QR status long poll timed out, treating as wait');
        return { status: 'wait' };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging endpoints (POST, with auth headers)
  // ---------------------------------------------------------------------------

  /**
   * Send a text message.
   *
   * POST /ilink/bot/sendmessage
   *
   * @param params - Message parameters
   */
  async sendText(params: {
    to: string;
    content: string;
    contextToken?: string;
  }): Promise<void> {
    const { to, content, contextToken } = params;
    const clientId = this.generateClientId();

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: content ? [{ type: 1, text_item: { text: content } }] : undefined,
        context_token: contextToken ?? undefined,
      },
      base_info: { channel_version: '0.0.1' },
    };

    await this.postJson('ilink/bot/sendmessage', body);
    logger.debug({ to, contentLength: content.length }, 'Text message sent');
  }

  // ---------------------------------------------------------------------------
  // Media endpoints (POST, with auth headers)
  // ---------------------------------------------------------------------------

  /**
   * Upload a media file to WeChat CDN.
   *
   * POST /ilink/bot/uploadmedia (multipart/form-data)
   *
   * @param params - Upload parameters
   * @returns Upload result with mediaId for use in sendImage/sendFile
   */
  async uploadMedia(params: {
    /** Absolute path to the file to upload */
    filePath: string;
    /** Media type override; auto-detected from extension if omitted */
    mediaType?: MediaType;
  }): Promise<MediaUploadResult> {
    const { filePath, mediaType: explicitType } = params;

    // Validate file exists and check size
    const stats = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const fileName = basename(filePath);
    const detectedType: MediaType = explicitType ?? (IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file');
    const maxSize = detectedType === 'image' ? MAX_IMAGE_SIZE_BYTES : MAX_FILE_SIZE_BYTES;

    if (stats.size > maxSize) {
      const maxMB = maxSize / (1024 * 1024);
      throw new Error(
        `File too large for ${detectedType} upload: ${stats.size} bytes (max ${maxMB}MB)`
      );
    }

    // Build multipart/form-data request
    const fileBuffer = readFileSync(filePath);
    const formData = new FormData();
    formData.append('media', new Blob([fileBuffer]), fileName);
    formData.append('type', detectedType);

    const url = `${this.baseUrl}/ilink/bot/uploadmedia`;

    // Build auth headers (without Content-Type — fetch sets it with boundary for FormData)
    const headers: Record<string, string> = {
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.randomWechatUin(),
    };

    if (this.token?.trim()) {
      headers['Authorization'] = `Bearer ${this.token.trim()}`;
    }
    if (this.routeTag) {
      headers['SKRouteTag'] = this.routeTag;
    }

    logger.info({ filePath, mediaType: detectedType, size: stats.size }, 'Uploading media to CDN');

    const data = await this.fetchJson<{ media_id?: string }>(url, {
      method: 'POST',
      headers,
      body: formData as unknown as string,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });

    if (!data.media_id) {
      throw new Error('Media upload failed: missing media_id in response');
    }

    logger.info({ mediaId: data.media_id, mediaType: detectedType }, 'Media uploaded successfully');
    return { mediaId: data.media_id, mediaType: detectedType };
  }

  /**
   * Send an image message.
   *
   * Convenience method that uploads the image to CDN then sends it.
   *
   * @param params - Image message parameters
   */
  async sendImage(params: {
    /** Target user/chat ID */
    to: string;
    /** Absolute path to the image file */
    filePath: string;
    /** Thread context token (optional) */
    contextToken?: string;
  }): Promise<void> {
    const { to, filePath, contextToken } = params;
    const upload = await this.uploadMedia({ filePath, mediaType: 'image' });
    await this.sendMediaMessage({
      to,
      mediaId: upload.mediaId,
      mediaType: 'image',
      fileName: basename(filePath),
      contextToken,
    });
    logger.debug({ to, mediaId: upload.mediaId }, 'Image message sent');
  }

  /**
   * Send a file message.
   *
   * Convenience method that uploads the file to CDN then sends it.
   *
   * @param params - File message parameters
   */
  async sendFile(params: {
    /** Target user/chat ID */
    to: string;
    /** Absolute path to the file */
    filePath: string;
    /** Thread context token (optional) */
    contextToken?: string;
  }): Promise<void> {
    const { to, filePath, contextToken } = params;
    const upload = await this.uploadMedia({ filePath, mediaType: 'file' });
    await this.sendMediaMessage({
      to,
      mediaId: upload.mediaId,
      mediaType: 'file',
      fileName: basename(filePath),
      contextToken,
    });
    logger.debug({ to, mediaId: upload.mediaId }, 'File message sent');
  }

  /**
   * Detect media type from file extension.
   *
   * @param filePath - Path to the file
   * @returns 'image' if the extension is a known image type, 'file' otherwise
   */
  detectMediaType(filePath: string): MediaType {
    const ext = extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a media message (image or file) using a pre-uploaded mediaId.
   *
   * POST /ilink/bot/sendmessage
   *
   * Image items use `{ type: 3, image_item: { media_id } }`.
   * File items use  `{ type: 4, file_item: { media_id, file_name } }`.
   */
  private async sendMediaMessage(params: {
    to: string;
    mediaId: string;
    mediaType: MediaType;
    fileName: string;
    contextToken?: string;
  }): Promise<void> {
    const { to, mediaId, mediaType, fileName, contextToken } = params;
    const clientId = this.generateClientId();

    // Build media item based on type
    const mediaItem = mediaType === 'image'
      ? { type: 3, image_item: { media_id: mediaId } }
      : { type: 4, file_item: { media_id: mediaId, file_name: fileName } };

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [mediaItem],
        context_token: contextToken ?? undefined,
      },
      base_info: { channel_version: '0.0.1' },
    };

    await this.postJson('ilink/bot/sendmessage', body);
  }

  /**
   * Make an authenticated POST request to the API.
   */
  private async postJson<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const bodyStr = JSON.stringify(body);

    const headers = this.buildAuthHeaders(bodyStr);

    logger.trace({ endpoint }, 'API POST request');

    const data = await this.fetchJson<T>(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
    });

    return data;
  }

  /**
   * Build authenticated headers for POST requests.
   * Matches the official @tencent-weixin/openclaw-weixin header format.
   */
  private buildAuthHeaders(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
      'X-WECHAT-UIN': this.randomWechatUin(),
    };

    if (this.token?.trim()) {
      headers['Authorization'] = `Bearer ${this.token.trim()}`;
    }

    if (this.routeTag) {
      headers['SKRouteTag'] = this.routeTag;
    }

    return headers;
  }

  /**
   * Generate a random X-WECHAT-UIN header value.
   * Matches official implementation: random uint32 -> decimal string -> base64.
   */
  private randomWechatUin(): string {
    const [uint32] = crypto.getRandomValues(new Uint32Array(1));
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
  }

  /**
   * Generate a random client ID for message sending.
   */
  private generateClientId(): string {
    return crypto.randomUUID();
  }

  /**
   * Common fetch wrapper with timeout and JSON parsing.
   */
  private async fetchJson<T>(url: string, opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '(unreadable)');
        logger.error({ url, status: response.status, body: text }, 'API request failed');
        throw new Error(`WeChat API error [${response.status}]: ${text}`);
      }

      const rawText = await response.text();
      const data = JSON.parse(rawText) as Record<string, unknown>;

      // Check for WeChat iLink error format (ret !== 0)
      const ret = data.ret as number | undefined;
      if (ret !== undefined && ret !== 0) {
        const errMsg = (data.err_msg as string) || (data.errmsg as string) || `Error code ${ret}`;
        logger.error({ url, ret, errMsg }, 'API returned error');
        throw new Error(`WeChat API error [${ret}]: ${errMsg}`);
      }

      return data as T;
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof Error && error.name === 'AbortError') {
        logger.error({ url }, 'API request timed out');
        throw error;
      }

      throw error;
    }
  }
}
