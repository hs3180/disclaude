/**
 * HTTP API Server for disclaude service.
 *
 * Provides a lightweight HTTP server for external tools (CLI, scripts) to
 * interact with disclaude service without going through Channel MCP.
 *
 * Phase 2 of Issue #3857: disclaude service HTTP API.
 *
 * Endpoints:
 * - `GET /api/status` — Basic health/status check
 * - `GET /api/health/detailed` — Process and opt-in dependency diagnostics
 * - `GET /api/ping` — Liveness probe (`{ pong: true }`); REST parity with REST API `ping` (#4279)
 * - `GET /api/temp-chats` — List tracked temporary chats (REST parity with REST API listTempChats; #4279)
 * - `POST /api/push` — Push message to agent (equivalent to push_to_agent)
 * - `POST /api/upload-file` — Upload a local file to a chat by filePath (REST parity with REST API uploadFile; #4279)
 * - `POST /api/send-message` — Send a text message to a chat (REST parity with REST API sendMessage; #4279)
 * - `POST /api/send-card` — Send a Feishu card to a chat (REST parity with REST API sendCard; #4279)
 * - `POST /api/send-interactive` — Send an interactive card (buttons) to a chat (REST parity with REST API sendInteractive; #4279)
 * - `POST /api/upload-image` — Upload a local image by filePath, returns image_key for card embedding (REST parity with REST API uploadImage; #4279)
 * - `POST /api/mark-chat-responded` — Mark a temp chat as responded (REST parity with REST API markChatResponded; #4281)
 *
 * Authentication:
 * - When `apiToken` is configured, non-GET routes require `Authorization: Bearer <token>`
 * - GET routes remain unauthenticated for health checks
 *
 * @module service/http-api-server
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from "../../core/dist/index.js";
import { SERVICE_VERSION } from './version.js';
const logger = createLogger('HttpApiServer');
/**
 * HTTP API Server — lightweight HTTP interface for disclaude service.
 *
 * Uses Node.js built-in `http` module (no external dependencies).
 * Supports simple pattern-based routing with named parameters.
 *
 * @example
 * ```typescript
 * const server = new HttpApiServer({ port: 19200 });
 * server.start();
 * // GET http://localhost:19200/api/status → { status: "ok", ... }
 * ```
 */
export class HttpApiServer {
    config;
    routes = [];
    server = null;
    startTime = 0;
    instanceId;
    pushHandler;
    uploadFileHandler;
    sendMessageHandler;
    sendCardHandler;
    sendInteractiveHandler;
    listTempChatsHandler;
    uploadImageHandler;
    markChatRespondedHandler;
    deliveryHealthProvider;
    /** Connected SSE clients for topic notifications (Issue #4031) */
    sseClients = new Set();
    /** Heartbeat interval timer for SSE keepalive */
    sseHeartbeat = null;
    constructor(config) {
        this.config = { host: 'localhost', ...config };
        this.setupRoutes();
    }
    /**
     * Set the node identifier for status responses.
     */
    setInstanceId(instanceId) {
        this.instanceId = instanceId;
    }
    /** Supply channel delivery counters without making health checks send a message. */
    setDeliveryHealthProvider(provider) {
        this.deliveryHealthProvider = provider;
    }
    /**
     * Return the address actually assigned by Node after the server starts.
     *
     * A configured port of 0 asks the OS for a free port; callers must use this
     * value instead of the requested port when handing the REST endpoint to a
     * managed client.
     */
    getAddress() {
        const address = this.server?.address();
        if (!address || typeof address === 'string') {
            return undefined;
        }
        return { host: address.address, port: address.port };
    }
    /**
     * Set the push handler for POST /api/push.
     *
     * The handler receives a chatId and message string, and routes them
     * to the appropriate agent via InputMessageRouter.
     */
    setPushHandler(handler) {
        this.pushHandler = handler;
    }
    /**
     * Set the handler for POST /api/upload-file (Issue #4279).
     */
    setUploadFileHandler(handler) {
        this.uploadFileHandler = handler;
    }
    /**
     * Set the handler for POST /api/send-message (Issue #4279).
     */
    setSendMessageHandler(handler) {
        this.sendMessageHandler = handler;
    }
    /**
     * Set the handler for POST /api/send-card (Issue #4279).
     */
    setSendCardHandler(handler) {
        this.sendCardHandler = handler;
    }
    /**
     * Set the handler for POST /api/send-interactive (Issue #4279).
     */
    setSendInteractiveHandler(handler) {
        this.sendInteractiveHandler = handler;
    }
    /**
     * Set the handler for GET /api/temp-chats (Issue #4279).
     */
    setListTempChatsHandler(handler) {
        this.listTempChatsHandler = handler;
    }
    /**
     * Set the handler for POST /api/upload-image (Issue #4279).
     */
    setUploadImageHandler(handler) {
        this.uploadImageHandler = handler;
    }
    /**
     * Set the handler for POST /api/mark-chat-responded (Issue #4281).
     */
    setMarkChatRespondedHandler(handler) {
        this.markChatRespondedHandler = handler;
    }
    /**
     * Broadcast a topic group message event to all connected SSE clients.
     *
     * Issue #4031: Local apps connect via GET /api/topic-stream to receive
     * real-time topic group message notifications.
     *
     * @param event - The topic group message event to broadcast
     */
    broadcastTopicEvent(event) {
        if (this.sseClients.size === 0) {
            return;
        }
        const data = JSON.stringify(event);
        const deadClients = [];
        for (const client of this.sseClients) {
            if (client.writableEnded) {
                deadClients.push(client);
                continue;
            }
            try {
                client.write(`data: ${data}\n\n`);
            }
            catch {
                deadClients.push(client);
            }
        }
        for (const client of deadClients) {
            this.sseClients.delete(client);
        }
    }
    /**
     * Start periodic heartbeat to keep SSE connections alive through proxies.
     *
     * Sends a comment frame every 15s. Idempotent — only starts once.
     */
    startSseHeartbeat() {
        if (this.sseHeartbeat) {
            return;
        }
        this.sseHeartbeat = setInterval(() => {
            if (this.sseClients.size === 0) {
                return;
            }
            const deadClients = [];
            for (const client of this.sseClients) {
                if (client.writableEnded) {
                    deadClients.push(client);
                    continue;
                }
                try {
                    client.write(': ping\n\n');
                }
                catch {
                    deadClients.push(client);
                }
            }
            for (const client of deadClients) {
                this.sseClients.delete(client);
            }
        }, 15_000);
    }
    /**
     * Stop the SSE heartbeat timer.
     */
    stopSseHeartbeat() {
        if (this.sseHeartbeat) {
            clearInterval(this.sseHeartbeat);
            this.sseHeartbeat = null;
        }
    }
    /**
     * Start the HTTP server.
     */
    async start() {
        if (this.server) {
            logger.warn('HTTP API server already running');
            return;
        }
        this.startTime = Date.now();
        await new Promise((resolve, reject) => {
            this.server = createServer((req, res) => {
                void this.handleRequest(req, res);
            });
            let listening = false;
            this.server.once('error', (err) => {
                if (!listening) {
                    if (err.code === 'EADDRINUSE') {
                        logger.error({ port: this.config.port }, 'Port already in use');
                    }
                    reject(err);
                }
            });
            this.server.listen(this.config.port, this.config.host, () => {
                listening = true;
                logger.info({ port: this.config.port, host: this.config.host }, 'HTTP API server listening');
                resolve();
            });
        });
    }
    /**
     * Stop the HTTP server.
     */
    async stop() {
        if (!this.server) {
            return;
        }
        // Close all SSE connections (Issue #4031)
        this.stopSseHeartbeat();
        for (const client of this.sseClients) {
            try {
                client.end();
            }
            catch {
                /* best effort */
            }
        }
        this.sseClients.clear();
        const serverToClose = this.server;
        this.server = null;
        await new Promise((resolve, reject) => {
            serverToClose.close((err) => {
                if (err) {
                    reject(err);
                }
                else {
                    logger.info('HTTP API server stopped');
                    resolve();
                }
            });
        });
    }
    /**
     * Whether the server is currently running.
     */
    get isRunning() {
        return this.server !== null;
    }
    /**
     * Register a route.
     */
    addRoute(method, pattern, handler) {
        // Convert pattern like "/api/status" or "/api/chat/:chatId" to regex
        const paramNames = [];
        const regexStr = pattern.replace(/:(\w+)/g, (_, name) => {
            paramNames.push(name);
            return '([^/]+)';
        });
        const regex = new RegExp(`^${regexStr}$`);
        this.routes.push({ method, pattern: regex, paramNames, handler });
    }
    /**
     * Set up default routes.
     */
    setupRoutes() {
        this.addRoute('GET', '/api/status', this.handleStatus.bind(this));
        this.addRoute('GET', '/api/health/detailed', this.handleDetailedHealth.bind(this));
        // Issue #4279: REST parity with REST API uploadFile.
        this.addRoute('POST', '/api/upload-file', this.handleUploadFile.bind(this));
        // Issue #4168 (Phase 1, #4279): REST parity with the REST API `ping` method —
        // a token-exempt (GET) health-check endpoint.
        this.addRoute('GET', '/api/ping', this.handlePing.bind(this));
        // Issue #4279: REST parity with REST API sendMessage.
        this.addRoute('POST', '/api/send-message', this.handleSendMessage.bind(this));
        // Issue #4279: REST parity with REST API sendCard.
        this.addRoute('POST', '/api/send-card', this.handleSendCard.bind(this));
        // Issue #4279: REST parity with REST API sendInteractive.
        this.addRoute('POST', '/api/send-interactive', this.handleSendInteractive.bind(this));
        // Issue #4279: REST parity with REST API listTempChats.
        this.addRoute('GET', '/api/temp-chats', this.handleListTempChats.bind(this));
        // Issue #4279: REST parity with REST API uploadImage.
        this.addRoute('POST', '/api/upload-image', this.handleUploadImage.bind(this));
        // Issue #4281: REST parity with REST API markChatResponded (temp-chat lifecycle).
        this.addRoute('POST', '/api/mark-chat-responded', this.handleMarkChatResponded.bind(this));
        this.addRoute('POST', '/api/push', this.handlePush.bind(this));
        // Issue #4031: SSE endpoint for topic group message notifications
        this.addRoute('GET', '/api/topic-stream', this.handleTopicStream.bind(this));
    }
    /**
     * Handle an incoming HTTP request.
     */
    async handleRequest(req, res) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const path = url.pathname;
        for (const route of this.routes) {
            if (req.method !== route.method) {
                continue;
            }
            const match = path.match(route.pattern);
            if (!match) {
                continue;
            }
            // API Token authentication for write routes (Issue #3857 Phase 2)
            // GET routes (health check) are unauthenticated; all other routes require Bearer token
            if (req.method !== 'GET' && this.config.apiToken) {
                const authHeader = req.headers.authorization;
                const expected = `Bearer ${this.config.apiToken}`;
                const authBuf = Buffer.from(authHeader ?? '');
                const expectedBuf = Buffer.from(expected);
                if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
                    this.sendJson(res, 401, {
                        error: 'Unauthorized',
                        message: 'Invalid or missing API token',
                    });
                    return;
                }
            }
            // Extract named parameters
            const params = {};
            for (let i = 0; i < route.paramNames.length; i++) {
                params[route.paramNames[i]] = match[i + 1];
            }
            try {
                await route.handler(req, res, params);
            }
            catch (err) {
                logger.error({ err, path }, 'Route handler error');
                this.sendJson(res, 500, { error: 'Internal server error' });
            }
            return;
        }
        this.sendJson(res, 404, { error: 'Not found' });
    }
    /**
     * GET /api/status handler.
     */
    handleStatus(_req, res, _params) {
        const response = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            instanceId: this.instanceId,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            version: SERVICE_VERSION,
        };
        this.sendJson(res, 200, response);
        return Promise.resolve();
    }
    /**
     * GET /api/ping handler.
     *
     * Issue #4168 (Phase 1, #4279): REST health-check endpoint. The response
     * payload mirrors the REST API `ping` method's payload (`{ pong: true }`); the REST API
     * envelope (`{ success: true, payload: ... }`) is dropped because HTTP 200
     * already signals success. GET routes are token-exempt (see the apiToken
     * check), so it works like /api/status for liveness probes.
     */
    handlePing(_req, res, _params) {
        this.sendJson(res, 200, { pong: true });
        return Promise.resolve();
    }
    /** GET /api/health/detailed — local process and delivery diagnostics. */
    handleDetailedHealth(_req, res, _params) {
        const delivery = this.deliveryHealthProvider?.() ?? {
            status: 'unknown',
            attempts: 0,
            successes: 0,
            failures: 0,
        };
        const status = delivery.status === 'degraded' ? 'degraded' : 'healthy';
        const response = {
            status,
            timestamp: new Date().toISOString(),
            process: { status: 'healthy', pid: process.pid, uptime: process.uptime() },
            delivery,
        };
        this.sendJson(res, status === 'healthy' ? 200 : 503, response);
        return Promise.resolve();
    }
    /**
     * GET /api/temp-chats handler (Issue #4279).
     *
     * Returns the list of tracked temporary chats (Issue #1703). Channel-agnostic
     * (no chatId). Single-process semantics — queries the local store; cross-
     * process aggregation is a future concern (Phase-0 decision 2) and would not
     * change this endpoint's contract. GET route → token-exempt (like /api/status).
     * Response: `{ ok: true, success, chats: [...] }`.
     */
    async handleListTempChats(_req, res, _params) {
        if (!this.listTempChatsHandler) {
            this.sendJson(res, 503, { ok: false, message: 'listTempChats handler not configured' });
            return;
        }
        try {
            const result = await this.listTempChatsHandler();
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err }, 'listTempChats handler error');
            const msg = err instanceof Error ? err.message : 'listTempChats failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * POST /api/push handler.
     *
     * Accepts `{ chatId: string, message: string }` and routes the message
     * to the agent via the configured PushHandler.
     */
    async handlePush(req, res, _params) {
        if (!this.pushHandler) {
            this.sendJson(res, 503, { ok: false, message: 'Push handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.chatId !== 'string' ||
            typeof parsed.message !== 'string') {
            this.sendJson(res, 400, {
                ok: false,
                message: 'Required fields: chatId (string), message (string)',
            });
            return;
        }
        const { chatId, message } = parsed;
        if (!chatId || !message) {
            this.sendJson(res, 400, { ok: false, message: 'chatId and message must be non-empty' });
            return;
        }
        try {
            await this.pushHandler(chatId, message);
            this.sendJson(res, 200, { ok: true, message: 'Push accepted' });
        }
        catch (err) {
            logger.error({ err, chatId }, 'Push handler error');
            const msg = err instanceof Error ? err.message : 'Push failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * POST /api/upload-file handler (Issue #4279).
     *
     * Accepts `{ chatId, filePath, threadId? }` and delegates to the channel's
     * uploadFile capability (reads the local file and uploads it). Uses a local
     * filePath rather than multipart because the REST face is localhost-bound —
     * the caller (MCP server) and disclaude service are co-located, so the file is
     * already readable on the host (exact REST API parity, no transfer needed).
     * Response: `{ ok: true, success, fileKey?, fileType?, fileName?, fileSize? }`.
     */
    async handleUploadFile(req, res, _params) {
        if (!this.uploadFileHandler) {
            this.sendJson(res, 503, { ok: false, message: 'uploadFile handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.chatId !== 'string' ||
            typeof parsed.filePath !== 'string') {
            this.sendJson(res, 400, {
                ok: false,
                message: 'Required fields: chatId (string), filePath (string)',
            });
            return;
        }
        const raw = parsed;
        // Reject empty chatId/filePath early — symmetric with handlePush/handleSendMessage.
        // Without this, an empty filePath would fall through to the handler and throw a
        // messy ENOENT 500 instead of a clean 400.
        if (!raw.chatId || !raw.filePath) {
            this.sendJson(res, 400, { ok: false, message: 'chatId and filePath must be non-empty' });
            return;
        }
        const threadId = typeof raw.threadId === 'string' ? raw.threadId : undefined;
        try {
            const result = await this.uploadFileHandler(raw.chatId, raw.filePath, threadId);
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err, chatId: raw.chatId }, 'uploadFile handler error');
            const msg = err instanceof Error ? err.message : 'uploadFile failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * POST /api/send-message handler (Issue #4279).
     *
     * Accepts `{ chatId, text, threadId?, mentions? }` and delegates to the
     * channel's sendMessage capability. Mirrors the REST API sendMessage method
     * (payload aligned with ChannelApiRequestPayloads). Response: `{ success, messageId? }`.
     */
    async handleSendMessage(req, res, _params) {
        if (!this.sendMessageHandler) {
            this.sendJson(res, 503, { ok: false, message: 'sendMessage handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.chatId !== 'string' ||
            typeof parsed.text !== 'string') {
            this.sendJson(res, 400, {
                ok: false,
                message: 'Required fields: chatId (string), text (string)',
            });
            return;
        }
        const raw = parsed;
        // Reject empty chatId/text early — symmetric with handlePush. Without this,
        // the channel would return a messy 500 on empty input instead of a clean 400.
        if (!raw.chatId || !raw.text) {
            this.sendJson(res, 400, { ok: false, message: 'chatId and text must be non-empty' });
            return;
        }
        const threadId = typeof raw.threadId === 'string' ? raw.threadId : undefined;
        // Validate mentions element shape (each must be { openId: string }). REST is
        // the trust boundary, so harden here even though the REST API path casts unchecked.
        const mentions = normalizeMentions(raw.mentions);
        if (mentions === null) {
            this.sendJson(res, 400, {
                ok: false,
                message: 'mentions must be an array of { openId: string; name?: string }',
            });
            return;
        }
        try {
            const result = await this.sendMessageHandler(raw.chatId, raw.text, threadId, mentions);
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err, chatId: raw.chatId }, 'sendMessage handler error');
            const msg = err instanceof Error ? err.message : 'sendMessage failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * POST /api/send-card handler (Issue #4279).
     *
     * Accepts `{ chatId, card, threadId?, description? }` and delegates to the
     * channel's sendCard capability. Mirrors the REST API sendCard method (payload
     * aligned with ChannelApiRequestPayloads). `card` is a Feishu card JSON object.
     * Response: `{ ok: true, success: true }`.
     */
    async handleSendCard(req, res, _params) {
        if (!this.sendCardHandler) {
            this.sendJson(res, 503, { ok: false, message: 'sendCard handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.chatId !== 'string' ||
            typeof parsed.card !== 'object' ||
            parsed.card === null) {
            this.sendJson(res, 400, {
                ok: false,
                message: 'Required fields: chatId (string), card (object)',
            });
            return;
        }
        const raw = parsed;
        const threadId = typeof raw.threadId === 'string' ? raw.threadId : undefined;
        const description = typeof raw.description === 'string' ? raw.description : undefined;
        try {
            const result = await this.sendCardHandler(raw.chatId, raw.card, threadId, description);
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err, chatId: raw.chatId }, 'sendCard handler error');
            const msg = err instanceof Error ? err.message : 'sendCard failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * POST /api/send-interactive handler (Issue #4279).
     *
     * Accepts `{ chatId, question, options, title?, context?, threadId?, actionPrompts? }`
     * and delegates to the channel's sendInteractive capability (which builds+sends
     * the card and registers action prompts). Mirrors the REST API sendInteractive method.
     * Response: `{ ok: true, success, messageId? }`.
     */
    async handleSendInteractive(req, res, _params) {
        if (!this.sendInteractiveHandler) {
            this.sendJson(res, 503, { ok: false, message: 'sendInteractive handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        const raw = parsed;
        if (typeof raw !== 'object' ||
            raw === null ||
            typeof raw.chatId !== 'string' ||
            typeof raw.question !== 'string' ||
            !Array.isArray(raw.options) ||
            raw.options.length === 0) {
            this.sendJson(res, 400, {
                ok: false,
                message: 'Required: chatId (string), question (string), options (non-empty array)',
            });
            return;
        }
        const params = {
            question: raw.question,
            options: raw.options,
            ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
            ...(typeof raw.context === 'string' ? { context: raw.context } : {}),
            ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
            ...(raw.actionPrompts &&
                typeof raw.actionPrompts === 'object' &&
                !Array.isArray(raw.actionPrompts)
                ? { actionPrompts: raw.actionPrompts }
                : {}),
        };
        try {
            const result = await this.sendInteractiveHandler(raw.chatId, params);
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err, chatId: raw.chatId }, 'sendInteractive handler error');
            const msg = err instanceof Error ? err.message : 'sendInteractive failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * GET /api/topic-stream — SSE endpoint for topic group message notifications.
     *
     * Issue #4031: Local apps connect to this endpoint to receive real-time
     * topic group message notifications via Server-Sent Events (SSE).
     * This replaces the originally planned WebSocket approach since the
     * WebSocketServerService was removed in Issue #2717.
     *
     * SSE is one-directional (server → client), which is exactly what's needed
     * for push notifications. No external dependencies required.
     */
    handleTopicStream(_req, res, _params) {
        // SSE requires HTTP/1.1 — set appropriate headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        // Send initial comment to establish connection
        res.write(': connected\n\n');
        // Track this client for broadcasting
        this.sseClients.add(res);
        this.startSseHeartbeat();
        logger.info({ clients: this.sseClients.size }, 'SSE client connected for topic notifications');
        // Remove client on disconnect
        res.on('close', () => {
            this.sseClients.delete(res);
            logger.info({ clients: this.sseClients.size }, 'SSE client disconnected from topic notifications');
        });
        return Promise.resolve();
    }
    /**
     * POST /api/upload-image handler (Issue #4279).
     *
     * Accepts `{ filePath }` and delegates to the channel's uploadImage capability
     * (reads the local image and returns a Feishu image_key for card embedding).
     * Channel-agnostic (no chatId). Uses a local filePath (see handleUploadFile
     * rationale: the REST face is localhost-bound, co-located, exact REST API parity).
     * Response: `{ ok: true, success, imageKey? }`.
     */
    async handleUploadImage(req, res, _params) {
        if (!this.uploadImageHandler) {
            this.sendJson(res, 503, { ok: false, message: 'uploadImage handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.filePath !== 'string') {
            this.sendJson(res, 400, { ok: false, message: 'Required field: filePath (string)' });
            return;
        }
        const raw = parsed;
        // Reject empty filePath early — symmetric with handlePush/handleSendMessage/handleUploadFile.
        // Without this, an empty filePath would fall through to the handler and throw a
        // messy ENOENT 500 instead of a clean 400.
        if (!raw.filePath) {
            this.sendJson(res, 400, { ok: false, message: 'filePath must be non-empty' });
            return;
        }
        try {
            const result = await this.uploadImageHandler(raw.filePath);
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err }, 'uploadImage handler error');
            const msg = err instanceof Error ? err.message : 'uploadImage failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * POST /api/mark-chat-responded handler (Issue #4281).
     *
     * Accepts `{ chatId, response: { selectedValue, responder, repliedAt } }` and
     * delegates to the channel's markChatResponded capability (temp-chat lifecycle,
     * Issue #1703). Mirrors the REST API markChatResponded method. Response:
     * `{ ok: true, success }`.
     */
    async handleMarkChatResponded(req, res, _params) {
        if (!this.markChatRespondedHandler) {
            this.sendJson(res, 503, { ok: false, message: 'markChatResponded handler not configured' });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
            return;
        }
        const raw = parsed;
        if (typeof raw !== 'object' || raw === null || typeof raw.chatId !== 'string' || !raw.chatId) {
            this.sendJson(res, 400, { ok: false, message: 'Required: chatId (non-empty string)' });
            return;
        }
        // REST is the trust boundary: validate the response payload shape that the
        // REST API path casts unchecked (mirror of normalizeMentions' rationale, #4279).
        const r = raw.response;
        if (typeof r !== 'object' ||
            r === null ||
            Array.isArray(r) ||
            typeof r.selectedValue !== 'string' ||
            typeof r.responder !== 'string' ||
            typeof r.repliedAt !== 'string') {
            this.sendJson(res, 400, {
                ok: false,
                message: 'Required: response { selectedValue (string), responder (string), repliedAt (string) }',
            });
            return;
        }
        try {
            const result = await this.markChatRespondedHandler(raw.chatId, {
                selectedValue: r.selectedValue,
                responder: r.responder,
                repliedAt: r.repliedAt,
            });
            this.sendJson(res, 200, { ok: true, ...result });
        }
        catch (err) {
            logger.error({ err, chatId: raw.chatId }, 'markChatResponded handler error');
            const msg = err instanceof Error ? err.message : 'markChatResponded failed';
            this.sendJson(res, 500, { ok: false, message: msg });
        }
    }
    /**
     * Send a JSON response.
     */
    sendJson(res, statusCode, body) {
        const json = JSON.stringify(body);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
    }
}
/** Maximum request body size (1 MB). */
const MAX_BODY_SIZE = 1024 * 1024;
/**
 * Read the full request body from an IncomingMessage.
 *
 * Rejects if the body exceeds MAX_BODY_SIZE to prevent memory issues.
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalSize = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            if (tooLarge) {
                return;
            }
            totalSize += chunk.length;
            if (totalSize > MAX_BODY_SIZE) {
                tooLarge = true;
                reject(new Error('Request body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!tooLarge) {
                resolve(Buffer.concat(chunks).toString('utf-8'));
            }
        });
        req.on('error', reject);
    });
}
/**
 * Normalize the optional `mentions` field of POST /api/send-message.
 *
 * Returns:
 * - `undefined` when the field is absent (no mentions).
 * - the typed array when every element is `{ openId: string; name?: string }`.
 * - `null` when the field is present but malformed (caller responds 400).
 *
 * REST is the trust boundary, so this validates element shape even though the
 * REST API path casts `mentions` unchecked (Issue #4279).
 */
function normalizeMentions(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        return null;
    }
    for (const m of raw) {
        if (typeof m !== 'object' ||
            m === null ||
            typeof m.openId !== 'string') {
            return null;
        }
    }
    return raw;
}
