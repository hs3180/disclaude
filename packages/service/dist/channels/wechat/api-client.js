/**
 * WeChat API Client (MVP).
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
 * - POST ilink/bot/typing              - Send typing indicator
 *
 * @module channels/wechat/api-client
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */
import { createLogger } from "../../../../core/dist/index.js";
const logger = createLogger('WeChatApiClient');
/** Default timeout for regular API requests (milliseconds). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Long-poll timeout for QR status / getUpdates (milliseconds). */
const LONG_POLL_TIMEOUT_MS = 35_000;
/** Default bot type for QR code generation. */
const DEFAULT_BOT_TYPE = 3;
/** Maximum file size for CDN upload (20MB). */
const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;
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
    /**
     * Create a new WeChat API client.
     *
     * @param options - Client configuration
     */
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.token = options.token;
        this.routeTag = options.routeTag;
        this.botType = options.botType ?? DEFAULT_BOT_TYPE;
    }
    /**
     * Set the bot token (called after successful authentication).
     */
    setToken(token) {
        this.token = token;
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
    async getBotQrCode() {
        const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${this.botType}`;
        logger.info({ url }, 'Fetching QR code');
        const headers = {};
        if (this.routeTag) {
            headers['SKRouteTag'] = this.routeTag;
        }
        const response = await this.fetchJson(url, { method: 'GET', headers });
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
    async getQrCodeStatus(qrcode) {
        const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        const headers = {
            'iLink-App-ClientVersion': '1',
        };
        if (this.routeTag) {
            headers['SKRouteTag'] = this.routeTag;
        }
        try {
            const data = await this.fetchJson(url, { method: 'GET', headers, timeoutMs: LONG_POLL_TIMEOUT_MS });
            const status = (data.status || 'wait');
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
        await this.postJson('ilink/bot/sendmessage', body);
        logger.debug({ to, contentLength: content.length }, 'Text message sent');
    }
    // ---------------------------------------------------------------------------
    // Image & File sending — Issue #1556 Phase 3.2
    // ---------------------------------------------------------------------------
    /**
     * Send an image message via CDN URL.
     *
     * POST /ilink/bot/sendmessage (with image_item)
     *
     * @param params - Image message parameters
     */
    async sendImage(params) {
        const { to, imageUrl, contextToken } = params;
        const clientId = this.generateClientId();
        const body = {
            msg: {
                from_user_id: '',
                to_user_id: to,
                client_id: clientId,
                message_type: 2, // BOT
                message_state: 2, // FINISH
                item_list: [{ type: 2, image_item: { url: imageUrl } }],
                context_token: contextToken ?? undefined,
            },
            base_info: { channel_version: '0.0.1' },
        };
        await this.postJson('ilink/bot/sendmessage', body);
        logger.debug({ to, imageUrl }, 'Image message sent');
    }
    /**
     * Send a file message via CDN URL.
     *
     * POST /ilink/bot/sendmessage (with file_item)
     *
     * @param params - File message parameters
     */
    async sendFile(params) {
        const { to, fileUrl, fileName, contextToken } = params;
        const clientId = this.generateClientId();
        const body = {
            msg: {
                from_user_id: '',
                to_user_id: to,
                client_id: clientId,
                message_type: 2, // BOT
                message_state: 2, // FINISH
                item_list: [{ type: 3, file_item: { url: fileUrl, file_name: fileName } }],
                context_token: contextToken ?? undefined,
            },
            base_info: { channel_version: '0.0.1' },
        };
        await this.postJson('ilink/bot/sendmessage', body);
        logger.debug({ to, fileUrl, fileName }, 'File message sent');
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
        const { signal, timeoutMs = LONG_POLL_TIMEOUT_MS } = options ?? {};
        try {
            const data = await this.postJson('ilink/bot/getupdates', {}, { timeoutMs, signal });
            return data.update_list ?? [];
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
     * POST /ilink/bot/typing
     *
     * Informs the user that the bot is processing their message.
     * Failures are non-fatal and logged as warnings.
     *
     * @param params - Typing indicator parameters
     */
    async sendTyping(params) {
        const { to } = params;
        const body = {
            to_user_id: to,
        };
        try {
            await this.postJson('ilink/bot/typing', body, { timeoutMs: 5_000 });
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
     * POST /ilink/bot/upload
     *
     * @param params - Upload parameters
     * @returns CDN URL and file key of the uploaded file
     */
    async uploadMedia(params) {
        const { fileData, fileName, mimeType } = params;
        if (fileData.length > MAX_UPLOAD_SIZE_BYTES) {
            throw new Error(`File too large: ${fileData.length} bytes (max ${MAX_UPLOAD_SIZE_BYTES})`);
        }
        const url = `${this.baseUrl}/ilink/bot/upload`;
        const headers = this.buildAuthHeaders('');
        // Remove Content-Length and Content-Type as FormData will set them
        delete headers['Content-Length'];
        delete headers['Content-Type'];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS);
        try {
            const formData = new FormData();
            formData.append('file', new Blob([fileData], { type: mimeType || 'application/octet-stream' }), fileName);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'AuthorizationType': headers['AuthorizationType'] ?? '',
                    'Authorization': headers['Authorization'] ?? '',
                    'X-WECHAT-UIN': headers['X-WECHAT-UIN'] ?? '',
                    ...(this.routeTag ? { 'SKRouteTag': this.routeTag } : {}),
                },
                body: formData,
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!response.ok) {
                const text = await response.text().catch(() => '(unreadable)');
                logger.error({ status: response.status, body: text }, 'Upload failed');
                throw new Error(`WeChat upload error [${response.status}]: ${text}`);
            }
            const rawText = await response.text();
            const data = JSON.parse(rawText);
            const { ret } = data;
            if (ret !== undefined && ret !== 0) {
                const errMsg = data.err_msg || `Error code ${ret}`;
                throw new Error(`WeChat upload error [${ret}]: ${errMsg}`);
            }
            if (!data.url || !data.file_key) {
                throw new Error('Upload response missing url or file_key');
            }
            logger.info({ fileName, url: data.url, fileKey: data.file_key }, 'File uploaded to CDN');
            return { url: data.url, fileKey: data.file_key };
        }
        catch (error) {
            clearTimeout(timer);
            throw error;
        }
    }
    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------
    /**
     * Make an authenticated POST request to the API.
     */
    async postJson(endpoint, body, options) {
        const url = `${this.baseUrl}/${endpoint}`;
        const bodyStr = JSON.stringify(body);
        const headers = this.buildAuthHeaders(bodyStr);
        logger.trace({ endpoint }, 'API POST request');
        const data = await this.fetchJson(url, {
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
    buildAuthHeaders(body) {
        const headers = {
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
            const data = JSON.parse(rawText);
            // Check for WeChat iLink error format (ret !== 0)
            const ret = data.ret;
            if (ret !== undefined && ret !== 0) {
                const errMsg = data.err_msg || data.errmsg || `Error code ${ret}`;
                logger.error({ url, ret, errMsg }, 'API returned error');
                throw new Error(`WeChat API error [${ret}]: ${errMsg}`);
            }
            return data;
        }
        catch (error) {
            clearTimeout(timer);
            if (error instanceof Error && error.name === 'AbortError') {
                logger.error({ url }, 'API request timed out');
                throw error;
            }
            throw error;
        }
    }
}
