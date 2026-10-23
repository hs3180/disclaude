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
import { createLogger, registerConsumedSecretValue } from "../../../../core/dist/index.js";
import { validateWechatBaseUrl } from './state-store.js';
import { uploadEncryptedMedia } from './media.js';
const logger = createLogger('WeChatApiClient');
/** Default timeout for regular API requests (milliseconds). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Long-poll timeout for QR status / getUpdates (milliseconds). */
const LONG_POLL_TIMEOUT_MS = 35_000;
/** Default bot type for QR code generation. */
const DEFAULT_BOT_TYPE = 3;
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
function safeErrmsg(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.replace(/[\t\n\r ]+/gu, ' ').trim().slice(0, ERRMSG_MAX_CHARS);
    if (!text || !ERRMSG_SAFE.test(text) || ERRMSG_UNSAFE.test(text) || /[\w+/=-]{33,}/u.test(text)) {
        return undefined;
    }
    return text;
}
/** Safe diagnostics: never include raw response bodies, URLs or context tokens. */
export class WeChatApiError extends Error {
    code;
    authExpired;
    detail;
    constructor(code, detail) {
        const where = detail?.endpoint ? ` on ${detail.endpoint}` : '';
        const status = Number.isFinite(detail?.httpStatus) ? ` (HTTP ${detail?.httpStatus})` : '';
        const what = detail?.errmsg ? `: ${detail.errmsg}` : `: Error code ${code}`;
        super(`WeChat API error [${code}]${where}${status}${what}${code === -14 || code === 401 ? '; login required' : ''}`);
        this.code = code;
        this.name = 'WeChatApiError';
        this.authExpired = code === -14 || code === 401;
        this.detail = detail;
    }
}
/** Tokenize JSON so uint64 identifiers never pass through a JS number. */
function parseApiJson(text) {
    try {
        let idValue = false;
        const normalized = text.replace(/"(?:\\.|[^"\\])*"\s*:\s*|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],]/g, (token) => {
            if (/^".*:\s*$/s.test(token)) {
                idValue = ['message_id', 'msg_id', 'svr_id'].includes(JSON.parse(token.replace(/:\s*$/, '').trim()));
                return token;
            }
            const result = idValue && /^\d+$/.test(token) ? JSON.stringify(token) : token;
            idValue = false;
            return result;
        });
        return JSON.parse(normalized);
    }
    catch {
        throw new Error('WeChat API returned invalid JSON');
    }
}
/**
 * WeChat API Client for Tencent ilink Bot API (MVP).
 *
 * Provides typed methods for auth and text messaging.
 * Uses Bearer token authentication with `AuthorizationType: ilink_bot_token`.
 */
export class WeChatApiClient {
    baseUrl;
    token;
    routeTag;
    botType;
    updatesCursor = '';
    pendingCursor;
    pollTimeoutMs = LONG_POLL_TIMEOUT_MS;
    getUpdatesCursor() { return this.updatesCursor; }
    setUpdatesCursor(cursor) { this.updatesCursor = cursor; this.pendingCursor = undefined; }
    /** Commit only after the listener has accepted every message in the batch. */
    acknowledgeUpdates() {
        if (this.pendingCursor !== undefined) {
            this.updatesCursor = this.pendingCursor;
        }
        this.pendingCursor = undefined;
    }
    /**
     * Create a new WeChat API client.
     *
     * @param options - Client configuration
     */
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.token = options.token?.trim();
        if (this.token) {
            registerConsumedSecretValue(this.token);
        }
        this.routeTag = options.routeTag;
        this.botType = options.botType ?? DEFAULT_BOT_TYPE;
    }
    /**
     * Set the bot token (called after successful authentication).
     */
    setToken(token) {
        this.token = token.trim();
        registerConsumedSecretValue(this.token);
        logger.info('Bot token updated');
    }
    /**
     * Get the current bot token.
     */
    getToken() {
        return this.token;
    }
    /**
     * Check if the client has a valid token.
     */
    hasToken() {
        return !!this.token?.trim();
    }
    /**
     * Read-only credential diagnostic: can this account still read its own
     * configuration. Success proves neither login liveness nor delivery health —
     * #5478 observed `getconfig ret=0` seconds before `sendmessage ret=-2`, so
     * callers must present it as "account check passed", never as "messages can
     * be delivered".
     */
    async checkSession(userId) {
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
    async getBotQrCode(options) {
        const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${this.botType}`;
        logger.info({ url }, 'Fetching QR code');
        const body = JSON.stringify({ local_token_list: [] });
        const headers = { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '1' };
        if (this.routeTag) {
            headers['SKRouteTag'] = this.routeTag;
        }
        const response = await this.fetchJson(url, { method: 'POST', headers, body, signal: options?.signal, endpoint: '/ilink/bot/get_bot_qrcode' });
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
    async getQrCodeStatus(qrcode, options) {
        const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${options?.verifyCode ? `&verify_code=${encodeURIComponent(options.verifyCode)}` : ''}`;
        const headers = {
            'iLink-App-ClientVersion': '1',
            'iLink-App-Id': 'bot',
        };
        if (this.routeTag) {
            headers['SKRouteTag'] = this.routeTag;
        }
        try {
            const data = await this.fetchJson(url, { method: 'GET', headers, timeoutMs: LONG_POLL_TIMEOUT_MS, signal: options?.signal, endpoint: '/ilink/bot/get_qrcode_status' });
            const status = (data.status || 'wait');
            if (status === 'scaned_but_redirect' && data.redirect_host) {
                this.baseUrl = validateWechatBaseUrl(`https://${data.redirect_host}`);
            }
            if (status === 'confirmed') {
                if (typeof data.bot_token === 'string') {
                    this.setToken(data.bot_token);
                }
                if (data.baseurl) {
                    this.baseUrl = validateWechatBaseUrl(data.baseurl);
                }
                logger.info({ botId: data.ilink_bot_id }, 'QR code login confirmed');
            }
            return {
                status,
                botToken: data.bot_token,
                botId: data.ilink_bot_id,
                userId: data.ilink_user_id,
                baseUrl: data.baseurl,
            };
        }
        catch (error) {
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
    async sendText(params) {
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
        const result = await this.postMessage(body);
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
    async sendImage(params) {
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
        const result = await this.postMessage(body);
        return result.message_id;
    }
    /**
     * Send a file using an encrypted CDN reference.
     *
     * POST /ilink/bot/sendmessage (with file_item)
     *
     * @param params - File message parameters
     */
    async sendFile(params) {
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
        const result = await this.postMessage(body);
        return result.message_id;
    }
    /** Native iLink video: video_size is ciphertext bytes, as in Tencent's sender. */
    async sendVideo(params) {
        const { to, uploaded, contextToken } = params;
        const result = await this.postMessage({
            msg: {
                from_user_id: '', to_user_id: to, client_id: this.generateClientId(),
                message_type: 2, message_state: 2,
                item_list: [{ type: 5, video_item: { media: uploaded.media, video_size: uploaded.encryptedSize } }],
                context_token: contextToken,
            },
        });
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
    async getUpdates(options) {
        const { signal, timeoutMs = this.pollTimeoutMs } = options ?? {};
        this.pendingCursor = undefined;
        try {
            const data = await this.postJson('ilink/bot/getupdates', { get_updates_buf: this.updatesCursor, base_info: { channel_version: '0.0.1', bot_agent: 'Disclaude/0.6.5' } }, { timeoutMs, signal });
            this.pendingCursor = typeof data.get_updates_buf === 'string' ? data.get_updates_buf : undefined;
            const suggestedTimeout = data.longpolling_timeout_ms;
            if (typeof suggestedTimeout === 'number' && Number.isFinite(suggestedTimeout) && suggestedTimeout > 0) {
                this.pollTimeoutMs = Math.min(120_000, Math.max(1_000, suggestedTimeout + 5_000));
            }
            return data.msgs ?? data.update_list ?? [];
        }
        catch (error) {
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
    async sendTyping(params) {
        const { to } = params;
        try {
            const config = await this.postJson('ilink/bot/getconfig', {
                ilink_user_id: to, context_token: params.contextToken,
            }, { timeoutMs: 5_000 });
            if (!config.typing_ticket) {
                return;
            }
            await this.postJson('ilink/bot/sendtyping', { ilink_user_id: to, typing_ticket: config.typing_ticket, status: 1 }, { timeoutMs: 5_000 });
            logger.debug({ to }, 'Typing indicator sent');
        }
        catch (error) {
            // Typing indicator failure should not block message processing
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.warn({ err: errMsg, to }, 'Failed to send typing indicator (non-fatal)');
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
    async uploadMedia(params) {
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
    async postJson(endpoint, body, options) {
        const url = `${this.baseUrl}/${endpoint}`;
        const bodyStr = JSON.stringify({ ...body, base_info: { channel_version: '0.0.1', bot_agent: 'Disclaude' } });
        const headers = this.buildAuthHeaders(bodyStr);
        logger.trace({ endpoint }, 'API POST request');
        const data = await this.fetchJson(url, {
            method: 'POST',
            headers,
            body: bodyStr,
            timeoutMs: options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
            signal: options?.signal,
            endpoint: `/${endpoint.replace(/^\/+/, '')}`,
        });
        return data;
    }
    async postMessage(body) {
        try {
            return await this.postJson('ilink/bot/sendmessage', body);
        }
        catch (error) {
            if (error instanceof WeChatApiError) {
                throw error;
            }
            throw new Error('WeChat delivery outcome unknown after timeout, network or response failure; verify in WeChat before retrying');
        }
    }
    /**
     * Build authenticated headers for POST requests.
     * Matches the official @tencent-weixin/openclaw-weixin header format.
     */
    buildAuthHeaders(body) {
        const headers = {
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
    randomWechatUin() {
        const [uint32] = crypto.getRandomValues(new Uint32Array(1));
        return Buffer.from(String(uint32), 'utf-8').toString('base64');
    }
    /**
     * Generate a random client ID for message sending.
     */
    generateClientId() {
        return crypto.randomUUID();
    }
    /**
     * Common fetch wrapper with timeout and JSON parsing.
     */
    async fetchJson(url, opts) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Link external signal if provided
        const onAbort = () => controller.abort();
        if (opts.signal?.aborted) {
            onAbort();
        }
        else {
            opts.signal?.addEventListener('abort', onAbort, { once: true });
        }
        // An aborted request does not always reject on its own: a transport or
        // interceptor can drop the abort (#5479), leaving callers — and through
        // them shutdown — waiting forever. Settle on the abort signal itself so a
        // lost transport rejection can never outlive the controller.
        const aborted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => { reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true });
        });
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
            if (!response.ok) {
                await response.body?.cancel();
                throw this.apiError(response.status, { ...(opts.endpoint ? { endpoint: opts.endpoint } : {}), httpStatus: response.status });
            }
            const rawText = await response.text();
            const data = parseApiJson(rawText);
            // Check for WeChat iLink error format (ret !== 0)
            const code = Number(data.errcode || data.ret || 0);
            if (code !== 0) {
                const ret = Number(data.ret);
                const errcode = Number(data.errcode);
                const errmsg = safeErrmsg(data.errmsg ?? data.err_msg);
                const detail = {
                    endpoint: opts.endpoint ?? 'unknown',
                    ...(Number.isFinite(response.status) ? { httpStatus: response.status } : {}),
                    ...(Number.isFinite(ret) && ret !== 0 ? { ret } : {}),
                    ...(Number.isFinite(errcode) && errcode !== 0 ? { errcode } : {}),
                    ...(errmsg ? { errmsg } : {}),
                };
                throw this.apiError(code, detail);
            }
            return data;
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
        }
    }
    /** Build the rejection, recording only safe fields plus a short correlation ID (#5478). */
    apiError(code, detail) {
        const enriched = { ...detail, diagnosticId: crypto.randomUUID().slice(0, 8) };
        logger.warn({ code, ...enriched }, 'WeChat API request rejected');
        return new WeChatApiError(code, enriched);
    }
}
