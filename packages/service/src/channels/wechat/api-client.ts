/**
 * Tencent iLink API client.
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
 * - POST ilink/bot/getconfig           - Read account configuration
 * - POST ilink/bot/sendtyping          - Send typing indicator
 * - POST ilink/bot/getuploadurl        - Negotiate encrypted CDN upload
 *
 * @module channels/wechat/api-client
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import { createHash } from 'node:crypto';
import { createLogger, registerConsumedSecretValue, sanitizeDiagnosticText } from '@disclaude/core';
import type { WeChatGetUpdatesResponse, WeChatTypingResponse, WeChatUploadedMedia } from './types.js';
import { validateWechatBaseUrl } from './state-store.js';
import { uploadEncryptedMedia } from './media.js';
import { observedAgeMs, safeTransportCode, safeUpstreamId, safeWeChatChannelId, type WeChatSendDiagnostics, type WeChatSendFailure, type WeChatSendMessageType, type WeChatSendStage } from './send-diagnostics.js';

const logger = createLogger('WeChatApiClient');

/** Default timeout for regular API requests (milliseconds). */
const DEFAULT_API_TIMEOUT_MS = 15_000;

/** Long-poll timeout for QR status / getUpdates (milliseconds). */
const LONG_POLL_TIMEOUT_MS = 35_000;

/** Default bot type for QR code generation. */
const DEFAULT_BOT_TYPE = 3;

/**
 * Safe API failure detail: endpoint path, numeric verdicts, sanitized reason
 * and send observations. Never tokens, signed URLs, raw bodies or headers.
 */
export interface WeChatApiErrorDetail {
  endpoint?: string;
  httpStatus?: number;
  ret?: number;
  errcode?: number;
  errmsg?: string;
  diagnosticId?: string;
  send?: WeChatSendDiagnostics;
}

/** Mutable response observations belong to one request, even when polling overlaps sends. */
interface SendResponseTrace {
  stage: WeChatSendStage;
  timedOut: boolean;
  httpStatus?: number;
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upstreamRequestId?: string;
  upstreamTraceId?: string;
  serverErrorMessagePresent?: boolean;
  secrets: readonly string[];
  privateText?: string;
}

interface SendRequestBody extends Record<string, unknown> {
  msg: { to_user_id: string; client_id: string; context_token?: string; [field: string]: unknown };
}

const SEND_ENDPOINT = '/ilink/bot/sendmessage';

const ERRMSG_MAX_CHARS = 120;
/** Credential vocabulary and transport markers that must never pass through, even inside a server message. */
const ERRMSG_UNSAFE = /token|ticket|secret|signature|credential|password|authorization|https?:|\/\\|\/\//i;
/** Visible letters, numbers, punctuation and spaces only; long opaque runs (base64/hex) are dropped whole. */
const ERRMSG_SAFE = /^[\p{L}\p{N}\p{P}\p{Zs}]{1,120}$/u;

/**
 * Whitelist + truncate a server-provided message. A value that could carry a
 * credential, a signed URL or an opaque blob is dropped entirely rather than
 * partially redacted, so an unverified server string never reaches logs or the
 * operator as-is.
 */
function safeErrmsg(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string') { return undefined; }
  const normalized = value.replace(/[\t\n\r ]+/gu, ' ').trim();
  try { if (sanitizeDiagnosticText(normalized, secrets) !== normalized) { return undefined; } }
  catch { return undefined; }
  const text = normalized.slice(0, ERRMSG_MAX_CHARS);
  if (!text || !ERRMSG_SAFE.test(text) || ERRMSG_UNSAFE.test(text) || /[\w+/=-]{33,}/u.test(text)) { return undefined; }
  return text;
}

/** Safe diagnostics: never include raw response bodies, URLs or context tokens. */
export class WeChatApiError extends Error {
  readonly authExpired: boolean;
  readonly detail: WeChatApiErrorDetail | undefined;
  constructor(readonly code: number, detail?: WeChatApiErrorDetail) {
    const where = detail?.endpoint ? ` on ${detail.endpoint}` : '';
    const status = Number.isFinite(detail?.httpStatus) ? ` (HTTP ${detail?.httpStatus})` : '';
    const what = detail?.errmsg ? `: ${detail.errmsg}` : `: Error code ${code}`;
    super(`WeChat API error [${code}]${where}${status}${what}${code === -14 || code === 401 ? '; login required' : ''}`);
    this.name = 'WeChatApiError';
    this.authExpired = code === -14 || code === 401;
    this.detail = detail;
  }
}

/** The transport did not establish a delivery verdict. Expose only safe observations, never the raw cause. */
export class WeChatDeliveryUnknownError extends Error {
  constructor(readonly detail: WeChatApiErrorDetail) {
    super(`WeChat delivery outcome unknown after timeout, network or response failure; verify in WeChat before retrying [diag ${detail.diagnosticId}]`);
    this.name = 'WeChatDeliveryUnknownError';
  }
}

function numericCode(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) { return undefined; }
  const code = Number(value);
  return Number.isSafeInteger(code) ? code : undefined;
}

function recordSendResponse(trace: SendResponseTrace, data: Record<string, unknown>): void {
  trace.ret = numericCode(data.ret);
  trace.errcode = numericCode(data.errcode);
  const message = data.errmsg ?? data.err_msg;
  trace.serverErrorMessagePresent = typeof message === 'string' && message.length > 0;
  trace.errmsg = typeof message === 'string' && trace.privateText && (trace.privateText.length >= 4 || message.trim() === trace.privateText) && message.includes(trace.privateText)
    ? undefined : safeErrmsg(message, trace.secrets);
  trace.upstreamRequestId ??= safeUpstreamId(data.request_id, trace.secrets);
  trace.upstreamTraceId ??= safeUpstreamId(data.trace_id, trace.secrets);
}

/** Bound optional non-2xx JSON diagnostics; a slow, oversized or non-JSON body cannot erase the HTTP verdict. */
async function readHttpErrorJson(response: Response, aborted: Promise<never>): Promise<Record<string, unknown> | undefined> {
  if (!response.body) { return undefined; }
  if (!response.headers?.get?.('content-type')?.toLowerCase().includes('json')) {
    void response.body.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) { break; }
      bytes += value.byteLength;
      if (bytes > 16_384) { return undefined; }
      chunks.push(value);
    }
    const data = parseApiJson(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined;
  } catch { return undefined; }
  finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Tokenize JSON so uint64 identifiers never pass through a JS number. */
function parseApiJson(text: string): Record<string, unknown> {
  try {
    let idValue = false;
    const normalized = text.replace(/"(?:\\.|[^"\\])*"\s*:\s*|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],]/g, (token) => {
      if (/^".*:\s*$/s.test(token)) {
        idValue = ['message_id', 'msg_id', 'svr_id'].includes(JSON.parse(token.replace(/:\s*$/, '').trim()) as string);
        return token;
      }
      const result = idValue && /^\d+$/.test(token) ? JSON.stringify(token) : token;
      idValue = false;
      return result;
    });
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch { throw new Error('WeChat API returned invalid JSON'); }
}

/**
 * WeChat API Client for Tencent ilink Bot API (MVP).
 *
 * Provides typed methods for auth and text messaging.
 * Uses Bearer token authentication with `AuthorizationType: ilink_bot_token`.
 */
export class WeChatApiClient {
  private baseUrl: string;
  private token?: string;
  private readonly routeTag?: string;
  private readonly channelId?: string;
  private readonly botType: number;
  private updatesCursor = '';
  private pendingCursor?: string;
  private pollTimeoutMs = LONG_POLL_TIMEOUT_MS;
  /** Set only on a real accepted getUpdates response, never on an empty local timeout. */
  private lastAcceptedPollAt?: number;

  getUpdatesCursor(): string { return this.updatesCursor; }
  setUpdatesCursor(cursor: string): void { this.updatesCursor = cursor; this.pendingCursor = undefined; }

  /** Commit only after the listener has accepted every message in the batch. */
  acknowledgeUpdates(): void {
    if (this.pendingCursor !== undefined) { this.updatesCursor = this.pendingCursor; }
    this.pendingCursor = undefined;
  }

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
    /** Local registration identifier for correlating sends, never sent to iLink. */
    channelId?: string;
    /** Bot type for QR code generation (default: 3) */
    botType?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token?.trim();
    if (this.token) { registerConsumedSecretValue(this.token); }
    this.routeTag = options.routeTag;
    this.channelId = safeWeChatChannelId(options.channelId);
    this.botType = options.botType ?? DEFAULT_BOT_TYPE;
  }

  /**
   * Set the bot token (called after successful authentication).
   */
  setToken(token: string): void {
    this.token = token.trim();
    registerConsumedSecretValue(this.token);
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
    return !!this.token?.trim();
  }

  /**
   * Read-only credential diagnostic: can this account still read its own
   * configuration. Success proves neither login liveness nor delivery health —
   * #5478 observed `getconfig ret=0` seconds before `sendmessage ret=-2`, so
   * callers must present it as "account check passed", never as "messages can
   * be delivered".
   */
  async checkSession(userId: string): Promise<void> {
    await this.postJson('ilink/bot/getconfig', { ilink_user_id: userId });
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
  async getBotQrCode(options?: { signal?: AbortSignal }): Promise<{ qrcode: string; qrUrl: string }> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${this.botType}`;
    logger.info({ url }, 'Fetching QR code');

    const body = JSON.stringify({ local_token_list: [] });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '1' };
    if (this.routeTag) {
      headers['SKRouteTag'] = this.routeTag;
    }

    const response = await this.fetchJson<{ qrcode?: string; qrcode_img_content?: string }>(url, { method: 'POST', headers, body, signal: options?.signal, endpoint: '/ilink/bot/get_bot_qrcode' });

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
  async getQrCodeStatus(qrcode: string, options?: { signal?: AbortSignal; verifyCode?: string }): Promise<{
    status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
    botToken?: string;
    botId?: string;
    userId?: string;
    baseUrl?: string;
  }> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${options?.verifyCode ? `&verify_code=${encodeURIComponent(options.verifyCode)}` : ''}`;

    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
      'iLink-App-Id': 'bot',
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
        redirect_host?: string;
      }>(url, { method: 'GET', headers, timeoutMs: LONG_POLL_TIMEOUT_MS, signal: options?.signal, endpoint: '/ilink/bot/get_qrcode_status' });

      const status = (data.status || 'wait') as Awaited<ReturnType<WeChatApiClient['getQrCodeStatus']>>['status'];

      if (status === 'scaned_but_redirect' && data.redirect_host) {
        this.baseUrl = validateWechatBaseUrl(`https://${data.redirect_host}`);
      }

      if (status === 'confirmed') {
        if (typeof data.bot_token === 'string') { this.setToken(data.bot_token); }
        if (data.baseurl) { this.baseUrl = validateWechatBaseUrl(data.baseurl); }
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
    contextObservedAt?: number;
  }): Promise<string | undefined> {
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

    const result = await this.postMessage(body, 'text', params.contextObservedAt, content);
    logger.debug({ to, contentLength: content.length }, 'Text message sent');
    return result.message_id;
  }

  // ---------------------------------------------------------------------------
  // Image & File sending — Issue #1556 Phase 3.2
  // ---------------------------------------------------------------------------

  /**
   * Send an image using an encrypted CDN reference.
   *
   * POST /ilink/bot/sendmessage (with image_item)
   *
   * @param params - Image message parameters
   */
  async sendImage(params: {
    to: string;
    uploaded: WeChatUploadedMedia;
    contextToken?: string;
    contextObservedAt?: number;
  }): Promise<string | undefined> {
    const { to, uploaded, contextToken } = params;
    const clientId = this.generateClientId();

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 2, image_item: { media: uploaded.media, mid_size: uploaded.encryptedSize } }],
        context_token: contextToken ?? undefined,
      },
      base_info: { channel_version: '0.0.1' },
    };

    const result = await this.postMessage(body, 'image', params.contextObservedAt, undefined, uploaded.media);
    return result.message_id;
  }

  /**
   * Send a file using an encrypted CDN reference.
   *
   * POST /ilink/bot/sendmessage (with file_item)
   *
   * @param params - File message parameters
   */
  async sendFile(params: {
    to: string;
    uploaded: WeChatUploadedMedia;
    fileName?: string;
    contextToken?: string;
    contextObservedAt?: number;
  }): Promise<string | undefined> {
    const { to, uploaded, fileName, contextToken } = params;
    const clientId = this.generateClientId();

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 4, file_item: { media: uploaded.media, file_name: fileName, len: String(uploaded.size) } }],
        context_token: contextToken ?? undefined,
      },
      base_info: { channel_version: '0.0.1' },
    };

    const result = await this.postMessage(body, 'file', params.contextObservedAt, fileName, uploaded.media);
    return result.message_id;
  }

  /** Native iLink video: video_size is ciphertext bytes, as in Tencent's sender. */
  async sendVideo(params: {
    to: string;
    uploaded: WeChatUploadedMedia;
    contextToken?: string;
    contextObservedAt?: number;
  }): Promise<string | undefined> {
    const { to, uploaded, contextToken } = params;
    const result = await this.postMessage({
      msg: {
        from_user_id: '', to_user_id: to, client_id: this.generateClientId(),
        message_type: 2, message_state: 2,
        item_list: [{ type: 5, video_item: { media: uploaded.media, video_size: uploaded.encryptedSize } }],
        context_token: contextToken,
      },
    }, 'video', params.contextObservedAt, undefined, uploaded.media);
    return result.message_id;
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
    const { signal, timeoutMs = this.pollTimeoutMs } = options ?? {};
    this.pendingCursor = undefined;

    try {
      const data = await this.postJson<WeChatGetUpdatesResponse>(
        'ilink/bot/getupdates',
        { get_updates_buf: this.updatesCursor, base_info: { channel_version: '0.0.1', bot_agent: 'Disclaude/0.6.5' } },
        { timeoutMs, signal }
      );

      if (data && typeof data === 'object' && !Array.isArray(data)) { this.lastAcceptedPollAt = Date.now(); }
      this.pendingCursor = typeof data.get_updates_buf === 'string' ? data.get_updates_buf : undefined;
      const suggestedTimeout = data.longpolling_timeout_ms;
      if (typeof suggestedTimeout === 'number' && Number.isFinite(suggestedTimeout) && suggestedTimeout > 0) {
        this.pollTimeoutMs = Math.min(120_000, Math.max(1_000, suggestedTimeout + 5_000));
      }
      return data.msgs ?? data.update_list ?? [];
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
  // Typing indicator (Issue #1556 Phase 3.2)
  // ---------------------------------------------------------------------------

  /**
   * Send a typing indicator to a user.
   *
   * POST /ilink/bot/sendtyping (after getconfig)
   *
   * Informs the user that the bot is processing their message.
   * Failures are non-fatal and logged as warnings.
   *
   * @param params - Typing indicator parameters
   */
  async sendTyping(params: { to: string; contextToken?: string; status?: 1 | 2; signal?: AbortSignal }): Promise<boolean> {
    const { to } = params;

    try {
      const config = await this.postJson<{ typing_ticket?: string }>('ilink/bot/getconfig', {
        ilink_user_id: to, context_token: params.contextToken,
      }, { timeoutMs: 5_000, signal: params.signal });
      if (!config.typing_ticket) { return false; }
      await this.postJson<WeChatTypingResponse>(
        'ilink/bot/sendtyping',
        { ilink_user_id: to, typing_ticket: config.typing_ticket, status: params.status ?? 1 },
        { timeoutMs: 5_000, signal: params.signal }, // Short timeout for typing indicator
      );
      logger.debug({ status: params.status ?? 1 }, 'Typing indicator sent');
      return true;
    } catch (error) {
      // Typing indicator failure should not block message processing
      if (!params.signal?.aborted) {
        logger.warn({ status: params.status ?? 1, ...(error instanceof WeChatApiError ? {
          code: error.code, httpStatus: error.detail?.httpStatus,
        } : {}) }, 'Failed to send typing indicator (non-fatal)');
      }
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // CDN upload — Issue #1556 Phase 3.2
  // ---------------------------------------------------------------------------

  /**
   * Upload a file to WeChat CDN.
   *
   * POST /ilink/bot/getuploadurl, then encrypted CDN POST
   *
   * @param params - Upload parameters
   * @returns CDN URL and file key of the uploaded file
   */
  async uploadMedia(params: {
    fileData: Buffer;
    fileName: string;
    to: string;
    kind: 'image' | 'file' | 'video';
    /** #5720: cancellation passthrough for the CDN POST; aborts map to reason=cancelled. */
    signal?: AbortSignal;
  }): Promise<WeChatUploadedMedia> {
    return await uploadEncryptedMedia({
      ...params,
      requestUpload: (body) => this.postJson('ilink/bot/getuploadurl', body),
    });
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
    options?: { timeoutMs?: number; signal?: AbortSignal; sendTrace?: SendResponseTrace },
  ): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const bodyStr = JSON.stringify({ ...body, base_info: { channel_version: '0.0.1', bot_agent: 'Disclaude' } });

    const headers = this.buildAuthHeaders(bodyStr);

    logger.trace({ endpoint }, 'API POST request');

    const data = await this.fetchJson<T>(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      timeoutMs: options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      signal: options?.signal,
      endpoint: `/${endpoint.replace(/^\/+/, '')}`,
      sendTrace: options?.sendTrace,
    });

    return data;
  }

  private async postMessage(body: SendRequestBody, messageType: WeChatSendMessageType, contextObservedAt?: number,
    privateText?: string, media?: WeChatUploadedMedia['media']): Promise<{ message_id?: string }> {
    const startedAt = performance.now();
    const now = Date.now();
    const { to_user_id: peer, client_id: clientMessageId, context_token: contextToken } = body.msg;
    const trace: SendResponseTrace = {
      stage: 'request', timedOut: false,
      secrets: [this.token, this.routeTag, contextToken, peer, media?.encrypt_query_param, media?.aes_key, media?.full_url]
        .filter((value): value is string => !!value),
      privateText,
    };
    const replyContextPresent = !!contextToken;
    const replyContextObservedAgeMs = replyContextPresent ? observedAgeMs(contextObservedAt, now) : undefined;
    const lastAcceptedPollAgeMs = observedAgeMs(this.lastAcceptedPollAt, now);
    const peerHash = createHash('sha256').update(peer).digest('hex').slice(0, 12);
    const observation = (failure?: WeChatSendFailure, error?: unknown): WeChatSendDiagnostics => ({
      clientMessageId, channelId: this.channelId, peerHash, messageType, replyContextPresent, replyContextObservedAgeMs, lastAcceptedPollAgeMs,
      elapsedMs: Math.round(performance.now() - startedAt), stage: trace.stage, failure,
      transportCode: safeTransportCode(error), upstreamRequestId: trace.upstreamRequestId, upstreamTraceId: trace.upstreamTraceId,
      serverErrorMessagePresent: trace.serverErrorMessagePresent,
    });
    const responseDetail = () => ({ endpoint: SEND_ENDPOINT, httpStatus: trace.httpStatus, ret: trace.ret, errcode: trace.errcode, errmsg: trace.errmsg });
    try {
      const result = await this.postJson<{ message_id?: string }>('ilink/bot/sendmessage', body, { sendTrace: trace });
      logger.info({ event: 'wechat_send_result', outcome: 'accepted', endpoint: SEND_ENDPOINT,
        httpStatus: trace.httpStatus, ret: trace.ret, errcode: trace.errcode, send: observation(),
        platformMessageIdPresent: !!result.message_id, platformMessageId: safeUpstreamId(result.message_id, trace.secrets) }, 'WeChat message send result');
      return result;
    }
    catch (error) {
      if (error instanceof WeChatApiError) {
        const detail = { ...responseDetail(), ...error.detail, send: observation(trace.stage === 'http-response' ? 'http-rejected' : 'api-rejected') };
        logger.warn({ event: 'wechat_send_result', outcome: 'rejected', code: error.code, ...detail }, 'WeChat message send result');
        throw new WeChatApiError(error.code, detail);
      }
      const failure: WeChatSendFailure = trace.timedOut ? 'timeout' : error instanceof Error && error.name === 'AbortError'
        ? 'aborted' : trace.stage === 'response-json' ? 'invalid-response' : 'transport-error';
      const detail = { ...responseDetail(), diagnosticId: crypto.randomUUID().slice(0, 8), send: observation(failure, error) };
      logger.warn({ event: 'wechat_send_result', outcome: 'unknown', ...detail }, 'WeChat message send result');
      throw new WeChatDeliveryUnknownError(detail);
    }
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
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '1',
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
    /** Endpoint path label for safe diagnostics; a fixed literal, never a secret-bearing URL. */
    endpoint?: string;
    sendTrace?: SendResponseTrace;
  }): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    const controller = new AbortController();
    const trace = opts.sendTrace;
    const timer = setTimeout(() => {
      if (trace) { trace.timedOut = true; }
      controller.abort();
    }, timeoutMs);

    // An aborted request does not always reject on its own: a transport or
    // interceptor can drop the abort (#5479), leaving callers — and through
    // them shutdown — waiting forever. Settle on the abort signal itself so a
    // lost transport rejection can never outlive the controller.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort',
        () => { reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true });
    });
    // Link after the abort promise is observing the controller, including already-aborted callers.
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) { onAbort(); }
    else { opts.signal?.addEventListener('abort', onAbort, { once: true }); }

    try {
      const response = await Promise.race([
        fetch(url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal,
          redirect: 'error',
        }),
        aborted,
      ]);

      if (trace) {
        trace.httpStatus = Number.isFinite(response.status) ? response.status : undefined;
        trace.upstreamRequestId = safeUpstreamId(response.headers?.get?.('x-request-id'), trace.secrets);
        trace.upstreamTraceId = safeUpstreamId(response.headers?.get?.('x-trace-id'), trace.secrets);
      }
      if (!response.ok) {
        if (trace) {
          trace.stage = 'http-response';
          const data = await readHttpErrorJson(response, aborted);
          if (data) { recordSendResponse(trace, data); }
        } else { await response.body?.cancel(); }
        throw this.apiError(response.status, { ...(opts.endpoint ? { endpoint: opts.endpoint } : {}), httpStatus: response.status,
          ...(trace ? { ret: trace.ret, errcode: trace.errcode, errmsg: trace.errmsg } : {}) });
      }

      if (trace) { trace.stage = 'response-body'; }
      const rawText = await Promise.race([response.text(), aborted]);
      if (trace) { trace.stage = 'response-json'; }
      const data = parseApiJson(rawText);

      // Check for WeChat iLink error format (ret !== 0)
      if (trace) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) { throw new Error('WeChat API returned invalid JSON object'); }
        recordSendResponse(trace, data);
      }
      const ret = numericCode(data.ret);
      const errcode = numericCode(data.errcode);
      const code = errcode || ret || Number(data.errcode || data.ret || 0);
      if (trace && !Number.isFinite(code)) { throw new Error('WeChat API returned invalid status code'); }
      if (trace) { trace.stage = 'api-response'; }
      if (code !== 0) {
        const errmsg = trace ? trace.errmsg : safeErrmsg(data.errmsg ?? data.err_msg);
        const detail: WeChatApiErrorDetail = {
          endpoint: opts.endpoint ?? 'unknown',
          ...(Number.isFinite(response.status) ? { httpStatus: response.status } : {}),
          ...(ret !== undefined && (trace || ret !== 0) ? { ret } : {}),
          ...(errcode !== undefined && (trace || errcode !== 0) ? { errcode } : {}),
          ...(errmsg ? { errmsg } : {}),
        };
        throw this.apiError(code, detail);
      }

      return data as T;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Build the rejection, recording only safe fields plus a short correlation ID (#5478). */
  private apiError(code: number, detail: WeChatApiErrorDetail): WeChatApiError {
    const enriched = { ...detail, diagnosticId: crypto.randomUUID().slice(0, 8) };
    logger.warn({ code, ...enriched }, 'WeChat API request rejected');
    return new WeChatApiError(code, enriched);
  }
}
