/**
 * REST Channel Implementation.
 *
 * Provides a RESTful API for sending messages to the agent.
 * Users can make HTTP POST requests to interact with the agent.
 *
 * API Endpoints:
 * - POST /api/chat - Send a message and receive response (streaming)
 * - POST /api/chat/sync - Send a message and wait for complete response
 * - POST /api/chat/{chatId} - Async mode: send message or poll for response
 *   - With message body: returns 202 Accepted (message received)
 *   - Without body (poll): 200 OK (completed), 202 Accepted (processing), 204 No Content (no session)
 * - GET /api/health - Health check
 * - POST /api/files/upload - Upload a file (base64 encoded)
 * - GET /api/files/:fileId - Get file metadata
 * - GET /api/files/:fileId/download - Download a file (base64 encoded)
 *
 * @see Issue #583 - REST Channel file transfer
 * @see Issue #738 - REST async mode
 * @module service/channels/rest-channel
 */
import http from 'node:http';
import { createLogger, withTiming, BaseChannel } from "../../../core/dist/index.js";
import { v4 as uuidv4 } from 'uuid';
import { RestSessionManager } from './rest/session-manager.js';
import { FileRouteHandlers } from './rest/file-routes.js';
import { RouteHandlers } from './rest/route-handlers.js';
const logger = createLogger('RestChannel');
/**
 * REST Channel - Provides RESTful API for agent interaction.
 *
 * Features:
 * - POST /api/chat - Send message (streaming response)
 * - POST /api/chat/sync - Send message (synchronous response)
 * - POST /api/chat/{chatId} - Async mode: send message or poll for response
 * - GET /api/health - Health check
 * - POST /api/files/upload - Upload a file
 * - GET /api/files/:fileId - Get file metadata
 * - GET /api/files/:fileId/download - Download a file
 */
export class RestChannel extends BaseChannel {
    port;
    host;
    fileStorageDir;
    maxFileSize;
    fileStorageServiceProvider;
    // Session manager for async mode (Issue #4127: extracted from rest-channel.ts)
    sessionManager = new RestSessionManager();
    server;
    fileStorage;
    // Pending responses for sync mode (chatId -> PendingResponse)
    pendingResponses = new Map();
    // Response buffers for sync mode (messageId -> response text)
    responseBuffers = new Map();
    // Chat ID to message ID mapping
    chatToMessage = new Map();
    // File ID to Chat ID mapping (for file uploads)
    fileToChat = new Map();
    /** File-route handlers (Issue #4127: extracted to channels/rest/file-routes.ts). */
    fileRoutes = new FileRouteHandlers({
        getFileStorage: () => this.fileStorage,
        fileToChat: this.fileToChat,
        readBody: (req) => this.readBody(req),
        sendError: (res, status, message) => this.sendError(res, status, message),
    });
    // Issue #3808: InputMessageRouter for /api/push endpoint
    inputMessageRouter;
    /** Issue #4256 (part 2): pool-stats provider for /api/health diagnostics. */
    agentPoolStatsProvider;
    /** Control/push route handlers (Issue #4127 part 2: extracted to channels/rest/route-handlers.ts). */
    routeHandlers = new RouteHandlers({
        getInputMessageRouter: () => this.inputMessageRouter,
        readBody: (req) => this.readBody(req),
        sendError: (res, status, message) => this.sendError(res, status, message),
        emitControl: (command) => this.emitControl(command),
    });
    constructor(config = {}) {
        super(config, 'rest', 'REST');
        this.port = config.port ?? 3000;
        this.host = config.host ?? '127.0.0.1';
        this.fileStorageDir = config.fileStorageDir ?? './workspace/files';
        this.maxFileSize = config.maxFileSize ?? 100 * 1024 * 1024; // 100MB
        this.fileStorageServiceProvider = config.fileStorageServiceProvider;
        logger.info({ id: this.id, port: this.port, host: this.host }, 'RestChannel created');
    }
    async doStart() {
        // Initialize file storage service if provider is available
        if (this.fileStorageServiceProvider) {
            const { FileStorageService } = await this.fileStorageServiceProvider();
            this.fileStorage = new FileStorageService({
                storageDir: this.fileStorageDir,
                maxFileSize: this.maxFileSize,
            });
            await this.fileStorage.initialize();
            logger.info({ storageDir: this.fileStorageDir }, 'File storage initialized');
        }
        const server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch((error) => {
                logger.error({ err: error }, 'Failed to handle request');
                this.sendError(res, 500, 'Internal server error');
            });
        });
        this.server = server;
        // Start session cleanup timer
        this.sessionManager.start();
        return new Promise((resolve, reject) => {
            server.listen(this.port, this.host, () => {
                logger.info({ port: this.port, host: this.host }, 'RestChannel started');
                resolve();
            });
            server.on('error', (error) => {
                logger.error({ err: error }, 'Failed to start RestChannel');
                reject(error);
            });
        });
    }
    doStop() {
        // Stop session manager (cleanup timer + clear sessions)
        this.sessionManager.stop();
        // Clear all pending responses
        for (const [_chatId, pending] of this.pendingResponses) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Channel stopped'));
        }
        this.pendingResponses.clear();
        this.responseBuffers.clear();
        this.chatToMessage.clear();
        this.fileToChat.clear();
        // Shutdown file storage
        if (this.fileStorage) {
            this.fileStorage.shutdown();
            this.fileStorage = undefined;
        }
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.server = undefined;
                    logger.info('RestChannel stopped');
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    doSendMessage(message) {
        const messageId = this.chatToMessage.get(message.chatId);
        // Issue #1619: Return messageId for callers that need it (e.g., action prompt matching).
        // REST channel messageIds are synthetic, assigned during request intake.
        // For 'done' and 'text' types, messageId corresponds to the original request.
        // Handle 'done' type - task completion signal
        if (message.type === 'done') {
            // Sync mode: resolve pending response
            const pending = this.pendingResponses.get(message.chatId);
            if (pending) {
                // Get buffered response
                const buffer = messageId ? this.responseBuffers.get(messageId) : undefined;
                const responseText = buffer ? buffer.join('\n') : '';
                // Issue #3003: log task completion with elapsed timing
                const taskElapsedMs = Date.now() - pending.requestStartMs;
                logger.info({ chatId: message.chatId, messageId, responseLength: responseText.length, taskElapsedMs }, 'Task completed, resolving sync response');
                // Clear timeout and resolve
                clearTimeout(pending.timeout);
                pending.resolve(responseText);
                // Cleanup maps
                this.pendingResponses.delete(message.chatId);
                if (messageId) {
                    this.responseBuffers.delete(messageId);
                }
                this.chatToMessage.delete(message.chatId);
            }
            // Async mode: update session status
            if (this.sessionManager.has(message.chatId)) {
                this.sessionManager.complete(message.chatId);
                logger.info({ chatId: message.chatId, messageId }, 'Task completed, async session updated');
                // Cleanup response buffers for async mode
                if (messageId) {
                    this.responseBuffers.delete(messageId);
                }
                this.chatToMessage.delete(message.chatId);
            }
            if (!pending && !this.sessionManager.has(message.chatId)) {
                logger.warn({ chatId: message.chatId, messageId }, 'Received done but no pending response or session found');
            }
            return Promise.resolve();
        }
        // For text responses
        if (message.type === 'text' && message.text) {
            // Sync mode: buffer text responses
            if (messageId) {
                const buffer = this.responseBuffers.get(messageId);
                if (buffer) {
                    buffer.push(message.text);
                }
                else {
                    logger.warn({ chatId: message.chatId, messageId }, 'No buffer found for text message');
                }
            }
            // Async mode: add to session messages
            if (this.sessionManager.has(message.chatId)) {
                const now = Date.now();
                const assistantMessageId = `resp_${now}_${Math.random().toString(36).slice(2, 8)}`;
                this.sessionManager.addMessage(message.chatId, {
                    id: assistantMessageId,
                    role: 'assistant',
                    content: message.text,
                    timestamp: now,
                });
                logger.debug({ chatId: message.chatId, messageId: assistantMessageId }, 'Async session: added assistant message');
            }
        }
        return Promise.resolve(messageId);
    }
    checkHealth() {
        return this.server !== undefined;
    }
    /**
     * Get the capabilities of REST channel.
     * REST channel supports cards and markdown, but not threads or files via MCP tools.
     *
     * Issue #3530: Removed send_text/send_card/send_interactive/send_file from
     * supportedMcpTools. These channel tools route through the Feishu HTTP API (request →
     * Feishu API), which fails when Feishu channel is unavailable or has invalid
     * credentials (e.g., integration test environment). REST channel handles
     * responses through its own text buffering — the agent should output text
     * directly, not via send_text MCP tool.
     */
    getCapabilities() {
        return {
            supportsCard: true,
            supportsThread: false,
            supportsFile: false,
            supportsMarkdown: true,
            supportsMention: false,
            supportsUpdate: false,
            supportsStreaming: false,
            supportedMcpTools: [],
        };
    }
    /**
     * Check if this channel owns a given chatId.
     * REST channel chatIds follow the pattern "rest-" prefix or are UUIDs.
     * Since REST channel is a fallback, it only claims chatIds it explicitly recognizes.
     *
     * Issue #3824: Channel ownership query for post-restart routing.
     */
    ownsChatId(chatId) {
        // REST channel typically uses "rest-" prefixed or UUID-format chatIds
        return chatId.startsWith('rest-') || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId);
    }
    /**
     * Get the server port.
     */
    getPort() {
        return this.port;
    }
    /**
     * Set the InputMessageRouter for /api/push endpoint.
     * Called during channel wiring via REST_WIRED_DESCRIPTOR.setup().
     * @see Issue #3808 - External push_to_agent access
     */
    setInputMessageRouter(router) {
        this.inputMessageRouter = router;
    }
    /**
     * Issue #4256 (part 2): inject a pool-stats provider so /api/health can
     * report live agent-pool state (active/busy/idle/peak/evictions) for leak
     * diagnostics. Called during channel wiring via REST_WIRED_DESCRIPTOR.setup().
     * Optional — when unset, /api/health omits the `agentPool` field (the legacy
     * behavior), so existing deployments/tests are unaffected.
     */
    setAgentPoolStatsProvider(provider) {
        this.agentPoolStatsProvider = provider;
    }
    /**
     * Handle incoming HTTP request.
     */
    async handleRequest(req, res) {
        const url = req.url?.split('?')[0] || '/';
        // Health check: skip timing wrapper (lightweight endpoint)
        if (url === '/api/health' && req.method === 'GET') {
            this.handleHealth(req, res);
            return;
        }
        if (url === '/api/chat' && req.method === 'POST') {
            await withTiming(logger, 'http:POST /api/chat', undefined, () => this.handleChat(req, res, false));
            return;
        }
        if (url === '/api/chat/sync' && req.method === 'POST') {
            await withTiming(logger, 'http:POST /api/chat/sync', undefined, () => this.handleChat(req, res, true));
            return;
        }
        // Async mode: POST /api/chat/{chatId}
        const asyncChatMatch = url.match(/^\/api\/chat\/([^/]+)$/);
        if (asyncChatMatch && req.method === 'POST') {
            const [, chatId] = asyncChatMatch;
            await withTiming(logger, `http:POST /api/chat/${chatId}`, chatId, () => this.handleAsyncChat(req, res, chatId));
            return;
        }
        // Control endpoints
        if (url === '/api/control' && req.method === 'POST') {
            await withTiming(logger, 'http:POST /api/control', undefined, () => this.routeHandlers.handleControl(req, res));
            return;
        }
        // Issue #3808: Push instruction to agent (system message)
        if (url === '/api/push' && req.method === 'POST') {
            await withTiming(logger, 'http:POST /api/push', undefined, () => this.routeHandlers.handlePush(req, res));
            return;
        }
        // File upload endpoint
        if (url === '/api/files/upload' && req.method === 'POST') {
            await withTiming(logger, 'http:POST /api/files/upload', undefined, () => this.fileRoutes.handleUpload(req, res));
            return;
        }
        // File info and download endpoints
        const fileMatch = url.match(/^\/api\/files\/([^/]+)(\/download)?$/);
        if (fileMatch && req.method === 'GET') {
            const [, fileId, downloadSuffix] = fileMatch;
            if (downloadSuffix === '/download') {
                await withTiming(logger, `http:GET /api/files/${fileId}/download`, undefined, () => this.fileRoutes.handleDownload(req, res, fileId));
            }
            else {
                await withTiming(logger, `http:GET /api/files/${fileId}`, undefined, () => this.fileRoutes.handleInfo(req, res, fileId));
            }
            return;
        }
        // 404 for unknown routes
        this.sendError(res, 404, 'Not found');
    }
    /**
     * Handle health check request.
     */
    handleHealth(_req, res) {
        // Issue #3378: Include process exit listener count in health check for
        // monitoring process.on("exit") leaks from Claude Agent SDK's ProcessTransport.
        const exitListenerCount = process.listenerCount('exit');
        const body = {
            status: 'ok',
            channel: this.name,
            id: this.id,
            listeners: {
                exit: exitListenerCount,
            },
        };
        // Issue #4256 (part 2): surface live agent-pool state for leak diagnostics.
        // Optional — omitted when no provider is wired, preserving the legacy shape.
        if (this.agentPoolStatsProvider) {
            body.agentPool = this.agentPoolStatsProvider.getPoolStats();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }
    /**
     * Handle chat request.
     */
    async handleChat(req, res, syncMode) {
        // Read request body
        const body = await this.readBody(req);
        if (!body) {
            this.sendError(res, 400, 'Empty request body');
            return;
        }
        // Parse request
        let chatRequest;
        try {
            chatRequest = JSON.parse(body);
        }
        catch {
            this.sendError(res, 400, 'Invalid JSON');
            return;
        }
        // Do not silently turn a multimodal request into a text-only request.
        if (chatRequest?.attachments !== undefined &&
            (!Array.isArray(chatRequest.attachments) || chatRequest.attachments.length > 0)) {
            this.sendError(res, 400, 'REST chat attachments are not supported');
            return;
        }
        // Validate request
        if (!chatRequest.message) {
            this.sendError(res, 400, 'Message is required');
            return;
        }
        const chatId = chatRequest.chatId || uuidv4();
        const messageId = uuidv4();
        const { userId } = chatRequest;
        const requestStartMs = Date.now(); // Issue #3003: track request timing
        logger.info({ chatId, messageId, userId, syncMode, requestStartMs }, 'Received chat request');
        // For sync mode, set up response handling
        if (syncMode) {
            this.responseBuffers.set(messageId, []);
            this.chatToMessage.set(chatId, messageId);
        }
        // Emit as incoming message
        if (this.messageHandler) {
            try {
                const dispatchStartMs = Date.now();
                await this.messageHandler({
                    messageId,
                    chatId,
                    userId,
                    content: chatRequest.message,
                    messageType: 'text',
                    timestamp: requestStartMs,
                    threadId: chatRequest.threadId,
                });
                // Issue #3003: log dispatch latency
                const dispatchMs = Date.now() - dispatchStartMs;
                if (dispatchMs > 100) {
                    logger.info({ chatId, messageId, dispatchMs }, 'Message dispatch to agent completed (slow dispatch)');
                }
            }
            catch (error) {
                logger.error({ err: error, messageId }, 'Failed to handle message');
                this.sendError(res, 500, 'Failed to process message');
                return;
            }
        }
        else {
            logger.warn({ chatId, messageId }, 'No messageHandler registered');
        }
        // Prepare response
        const response = {
            success: true,
            messageId,
            chatId,
        };
        if (syncMode) {
            // Wait for response with timeout (4 minutes for AI processing)
            const timeoutMs = 240000; // 240 seconds (4 minutes)
            const responseText = await this.waitForResponse(chatId, messageId, timeoutMs, requestStartMs);
            response.response = responseText;
            // Issue #3003: log total request timing
            const totalMs = Date.now() - requestStartMs;
            logger.info({ chatId, messageId, totalMs, responseLength: responseText?.length ?? 0 }, 'Sync request completed');
            // Cleanup
            this.responseBuffers.delete(messageId);
            this.chatToMessage.delete(chatId);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }
    /**
     * Handle async chat request (non-blocking mode).
     *
     * POST /api/chat/{chatId}
     *
     * Behavior:
     * - With message body: Create/update session, return 202 Accepted
     * - Without message body (poll):
     *   - Session completed: 200 OK + response content
     *   - Session processing: 202 Accepted
     *   - No session: 204 No Content
     *
     * @see Issue #738 - REST async mode
     */
    async handleAsyncChat(req, res, chatId) {
        // Read request body
        const body = await this.readBody(req);
        // Parse request if body exists
        let chatRequest = null;
        if (body) {
            try {
                chatRequest = JSON.parse(body);
            }
            catch {
                this.sendError(res, 400, 'Invalid JSON');
                return;
            }
        }
        if (chatRequest?.attachments !== undefined &&
            (!Array.isArray(chatRequest.attachments) || chatRequest.attachments.length > 0)) {
            this.sendError(res, 400, 'REST chat attachments are not supported');
            return;
        }
        // Get or create session state
        const session = this.sessionManager.get(chatId);
        // Poll mode: no message in request
        if (!chatRequest?.message) {
            if (!session) {
                // No session exists
                logger.info({ chatId }, 'Async poll: no session');
                res.writeHead(204);
                res.end();
                return;
            }
            // Session exists, check status
            if (session.status === 'completed') {
                // Get assistant messages as response
                const assistantMessages = session.messages.filter(m => m.role === 'assistant');
                const responseText = assistantMessages.map(m => m.content).join('\n');
                logger.info({ chatId, responseLength: responseText.length }, 'Async poll: completed');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    chatId,
                    status: session.status,
                    response: responseText,
                    messageId: session.lastMessageId,
                }));
                return;
            }
            // Still processing
            logger.info({ chatId, status: session.status }, 'Async poll: processing');
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                chatId,
                status: session.status,
                messageId: session.lastMessageId,
            }));
            return;
        }
        // Send message mode: has message in request
        const messageId = uuidv4();
        const { userId } = chatRequest;
        const now = Date.now();
        // Create new session or update existing
        if (!session) {
            this.sessionManager.create(chatId);
        }
        // Add user message and mark session as processing
        this.sessionManager.addMessage(chatId, {
            id: messageId,
            role: 'user',
            content: chatRequest.message,
            timestamp: now,
        });
        this.sessionManager.setStatus(chatId, 'processing');
        // Set up response buffer for this message
        this.responseBuffers.set(messageId, []);
        this.chatToMessage.set(chatId, messageId);
        logger.info({ chatId, messageId, userId }, 'Async chat: message received');
        // Emit as incoming message
        if (this.messageHandler) {
            try {
                await this.messageHandler({
                    messageId,
                    chatId,
                    userId,
                    content: chatRequest.message,
                    messageType: 'text',
                    timestamp: now,
                });
            }
            catch (error) {
                logger.error({ err: error, messageId }, 'Failed to handle async message');
                this.sessionManager.setStatus(chatId, 'error');
                this.sendError(res, 500, 'Failed to process message');
                return;
            }
        }
        else {
            logger.warn({ chatId, messageId }, 'No messageHandler registered');
        }
        // Return 202 Accepted immediately
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            messageId,
            chatId,
            status: 'processing',
        }));
    }
    /**
     * Wait for response in sync mode.
     */
    waitForResponse(chatId, messageId, timeoutMs, requestStartMs) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingResponses.delete(chatId);
                this.responseBuffers.delete(messageId);
                // Issue #3003: log detailed timing summary on timeout
                const elapsedMs = Date.now() - requestStartMs;
                logger.warn({ chatId, messageId, elapsedMs, timeoutMs, timeoutExceededBy: elapsedMs - timeoutMs }, 'Sync response timeout — no response received within timeout. '
                    + 'Check server logs for this chatId to identify the slow stage.');
                reject(new Error('Response timeout'));
            }, timeoutMs);
            // Check if response is already available
            const buffer = this.responseBuffers.get(messageId);
            if (buffer && buffer.length > 0) {
                clearTimeout(timeout);
                resolve(buffer.join('\n'));
                return;
            }
            // Store pending response
            this.pendingResponses.set(chatId, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                response: [],
                timeout,
                requestStartMs, // Issue #3003: store for elapsed tracking
            });
        });
    }
    /**
     * Read request body.
     */
    readBody(req) {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                resolve(body);
            });
            req.on('error', () => {
                resolve('');
            });
        });
    }
    /**
     * Send error response.
     */
    sendError(res, status, message) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: message,
        }));
    }
    /**
     * Get current session count (for monitoring/debugging).
     * Delegates to RestSessionManager (Issue #4127).
     * @see Issue #1263 - Session state memory leak fix
     */
    getSessionCount() {
        return this.sessionManager.count();
    }
}
