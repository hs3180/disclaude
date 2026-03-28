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
 * - POST ilink/bot/sendmessage         - Send a message
 * - POST ilink/bot/getupdates          - Long-poll for incoming messages
 *
 * @module channels/wechat/api-client
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import { createLogger } from '@disclaude/core';
import type { WeChatGetUpdatesResponse } from './types.js';

const logger = createLogger('WeChatApiClient');

/** Default timeout for regular API requests (milliseconds). */
const DEFAULT_API_TIMEOUT_MS = 15_000;

/** Long-poll timeout for QR status / getUpdates (milliseconds). */
const LONG_POLL_TIMEOUT_MS = 35_000;

/** Default bot type for QR code generation. */
const DEFAULT_BOT_TYPE = 3;

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
  // Message listening (getUpdates long-poll) — Issue #1556 Phase 3.1
  // ---------------------------------------------------------------------------

  /**
   * Long-poll for incoming messages.
   *
   * POST /ilink/bot/getupdates
   *
   * Blocks until new messages arrive or timeout (35s).
   * On client-side timeout, returns empty array (normal for long polling).
   *
   * @param options - Poll options
   * @returns Array of new message updates (empty on timeout)
   */
  async getUpdates(options?: {
    /** AbortSignal for graceful shutdown */
    signal?: AbortSignal;
    /** Custom timeout in ms (default: 35s) */
    timeoutMs?: number;
  }): Promise<import('./types.js').WeChatUpdate[]> {
    const timeoutMs = options?.timeoutMs ?? LONG_POLL_TIMEOUT_MS;

    try {
      const data = await this.postJson<WeChatGetUpdatesResponse>(
        'ilink/bot/getupdates',
        {},
        { timeoutMs, signal: options?.signal },
      );

      return data.update_list ?? [];
    } catch (error) {
      // Timeout during long polling is normal — return empty
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('getUpdates long poll timed out, returning empty');
        return [];
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Make an authenticated POST request to the API.
   */
  private async postJson<T>(
    endpoint: string,
    body: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const bodyStr = JSON.stringify(body);

    const headers = this.buildAuthHeaders(bodyStr);

    logger.trace({ endpoint }, 'API POST request');

    const data = await this.fetchJson<T>(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      timeoutMs: options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      signal: options?.signal,
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
    signal?: AbortSignal;
  }): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Link external signal if provided
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

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
