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
 * @module primary-node/channels/rest-channel
 */

import http from 'node:http';
import { createLogger, type FileRef, type ChannelConfig, type OutgoingMessage, type ControlCommand, type ChannelCapabilities, BaseChannel } from '@disclaude/core';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('RestChannel');

/**
 * File storage service interface for dependency injection.
 */
export interface IFileStorageService {
  initialize(): Promise<void>;
  shutdown(): void;
  storeFromBase64(content: string, fileName: string, mimeType?: string, userId?: string, chatId?: string): Promise<FileRef>;
  get(fileId: string): { ref: FileRef } | undefined;
  getContent(fileId: string): Promise<string>;
}

/**
 * REST channel configuration.
 */
export interface RestChannelConfig extends ChannelConfig {
  /** Server port (default: 3000) */
  port?: number;
  /** Server host (default: '127.0.0.1') */
  host?: string;
  /** File storage directory (default: './workspace/files') */
  fileStorageDir?: string;
  /** Maximum file size in bytes (default: 100MB) */
  maxFileSize?: number;
  /** File storage service provider (for dependency injection) */
  fileStorageServiceProvider?: () => Promise<{ FileStorageService: new (config: { storageDir: string; maxFileSize: number }) => IFileStorageService }>;
  /** API prefix for routes (default: '/api') */
  apiPrefix?: string;
}

/**
 * API request body for sending messages.
 */
interface ChatRequest {
  /** Chat/conversation ID (auto-generated if not provided) */
  chatId?: string;
  /** User message content */
  message: string;
  /** User ID (optional) */
  userId?: string;
  /** Thread root message ID for thread context (optional) */
  threadId?: string;
  /** Response mode: 'stream' or 'sync' */
  mode?: 'stream' | 'sync';
}

/**
 * API response structure.
 */
interface ChatResponse {
  /** Success status */
  success: boolean;
  /** Message ID for tracking */
  messageId: string;
  /** Chat ID */
  chatId: string;
  /** Response text (sync mode only) */
  response?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * File upload request structure.
 */
interface FileUploadRequest {
  /** File name */
  fileName: string;
  /** MIME type (optional) */
  mimeType?: string;
  /** File content (base64 encoded) */
  content: string;
  /** Associated chat ID (optional) */
  chatId?: string;
}
/**
 * File upload response structure.
 */
interface FileUploadResponse {
  /** Success status */
  success: boolean;
  /** File reference */
  file?: FileRef;
  /** Error message (if failed) */
  error?: string;
}
/**
 * File info response structure.
 */
interface FileInfoResponse {
  /** Success status */
  success: boolean;
  /** File reference */
  file?: FileRef;
  /** Error message (if failed) */
  error?: string;
}
/**
 * File download response structure.
 */
interface FileDownloadResponse {
  /** Success status */
  success: boolean;
  /** File reference */
  file?: FileRef;
  /** File content (base64 encoded) */
  content?: string;
  /** Error message (if failed) */
  error?: string;
}
/**
 * Pending response for sync mode.
 */
interface PendingResponse {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  response: string[];
  timeout: NodeJS.Timeout;
  /** Timestamp when the request was first received (Issue #3003) */
  requestStartMs: number;
}
/**
 * Session status for async mode.
 */
type SessionStatus = 'pending' | 'processing' | 'completed' | 'error';
/**
 * Stored message in session.
 */
interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
/**
 * Session state for async mode.
 */
interface SessionState {
  chatId: string;
  status: SessionStatus;
  messages: SessionMessage[];
  lastMessageId?: string;
  createdAt: number;
  updatedAt: number;
}
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
export class RestChannel extends BaseChannel<RestChannelConfig> {
  private port: number;
  private host: string;
  private fileStorageDir: string;
  private maxFileSize: number;
  private fileStorageServiceProvider?: RestChannelConfig['fileStorageServiceProvider'];

  // Hardcoded session management defaults
  private static readonly SESSION_TTL = 3600000; // 1 hour
  private static readonly MAX_SESSIONS = 10000;
  private static readonly CLEANUP_INTERVAL_MS = 60000; // 1 minute

  private server?: http.Server;
  private fileStorage?: IFileStorageService;
  private cleanupTimer?: NodeJS.Timeout;

  // Pending responses for sync mode (chatId -> PendingResponse)
  private pendingResponses = new Map<string, PendingResponse>();
  // Response buffers for sync mode (messageId -> response text)
  private responseBuffers = new Map<string, string[]>();
  // Chat ID to message ID mapping
  private chatToMessage = new Map<string, string>();
  // File ID to Chat ID mapping (for file uploads)
  private fileToChat = new Map<string, string>();
  // Session states for async mode (chatId -> SessionState)
  private sessionStates = new Map<string, SessionState>();

  constructor(config: RestChannelConfig = {}) {
    super(config, 'rest', 'REST');
    this.port = config.port ?? 3000;
    this.host = config.host ?? '127.0.0.1';
    this.fileStorageDir = config.fileStorageDir ?? './workspace/files';
    this.maxFileSize = config.maxFileSize ?? 100 * 1024 * 1024; // 100MB
    this.fileStorageServiceProvider = config.fileStorageServiceProvider;

    logger.info({ id: this.id, port: this.port, host: this.host }, 'RestChannel created');
  }

  protected async doStart(): Promise<void> {
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
    this.startSessionCleanup();

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

  protected doStop(): Promise<void> {
    // Stop session cleanup timer
    this.stopSessionCleanup();

    // Clear all pending responses
    for (const [_chatId, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Channel stopped'));
    }
    this.pendingResponses.clear();
    this.responseBuffers.clear();
    this.chatToMessage.clear();
    this.fileToChat.clear();
    this.sessionStates.clear();

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
      } else {
        resolve();
      }
    });
  }

  protected doSendMessage(message: OutgoingMessage): Promise<string | void> {
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
        logger.info(
          { chatId: message.chatId, messageId, responseLength: responseText.length, taskElapsedMs },
          'Task completed, resolving sync response'
        );

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
      const session = this.sessionStates.get(message.chatId);
      if (session) {
        session.status = 'completed';
        session.updatedAt = Date.now();
        logger.info(
          { chatId: message.chatId, messageId },
          'Task completed, async session updated'
        );

        // Cleanup response buffers for async mode
        if (messageId) {
          this.responseBuffers.delete(messageId);
        }
        this.chatToMessage.delete(message.chatId);
      }

      if (!pending && !session) {
        logger.warn(
          { chatId: message.chatId, messageId },
          'Received done but no pending response or session found'
        );
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
        } else {
          logger.warn(
            { chatId: message.chatId, messageId },
            'No buffer found for text message'
          );
        }
      }

      // Async mode: add to session messages
      const session = this.sessionStates.get(message.chatId);
      if (session) {
        const now = Date.now();
        const assistantMessageId = `resp_${now}_${Math.random().toString(36).slice(2, 8)}`;
        session.messages.push({
          id: assistantMessageId,
          role: 'assistant',
          content: message.text,
          timestamp: now,
        });
        session.lastMessageId = assistantMessageId;
        session.updatedAt = now;
        logger.debug(
          { chatId: message.chatId, messageId: assistantMessageId },
          'Async session: added assistant message'
        );
      }
    }

    return Promise.resolve(messageId);
  }

  protected checkHealth(): boolean {
    return this.server !== undefined;
  }

  /**
   * Get the capabilities of REST channel.
   * REST channel supports cards and markdown, but not threads or files via MCP tools.
   * Issue #590 Phase 3: Added supportedMcpTools for dynamic prompt adaptation.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsCard: true,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
      supportedMcpTools: ['send_text', 'send_card', 'send_interactive', 'send_file'],
    };
  }

  /**
   * Get the server port.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url?.split('?')[0] || '/';

    // Route requests
    if (url === '/api/health' && req.method === 'GET') {
      this.handleHealth(req, res);
      return;
    }

    if (url === '/api/chat' && req.method === 'POST') {
      await this.handleChat(req, res, false);
      return;
    }

    if (url === '/api/chat/sync' && req.method === 'POST') {
      await this.handleChat(req, res, true);
      return;
    }

    // Async mode: POST /api/chat/{chatId}
    const asyncChatMatch = url.match(/^\/api\/chat\/([^/]+)$/);
    if (asyncChatMatch && req.method === 'POST') {
      const [, chatId] = asyncChatMatch;
      await this.handleAsyncChat(req, res, chatId);
      return;
    }

    // Control endpoints
    if (url === '/api/control' && req.method === 'POST') {
      await this.handleControl(req, res);
      return;
    }

    // File upload endpoint
    if (url === '/api/files/upload' && req.method === 'POST') {
      await this.handleFileUpload(req, res);
      return;
    }

    // File info and download endpoints
    const fileMatch = url.match(/^\/api\/files\/([^/]+)(\/download)?$/);
    if (fileMatch && req.method === 'GET') {
      const [, fileId, downloadSuffix] = fileMatch;
      if (downloadSuffix === '/download') {
        await this.handleFileDownload(req, res, fileId);
      } else {
        await this.handleFileInfo(req, res, fileId);
      }
      return;
    }

    // 404 for unknown routes
    this.sendError(res, 404, 'Not found');
  }

  /**
   * Handle health check request.
   */
  private handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      channel: this.name,
      id: this.id,
    }));
  }

  /**
   * Handle chat request.
   */
  private async handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  syncMode: boolean
  ): Promise<void> {
    // Read request body
    const body = await this.readBody(req);
    if (!body) {
      this.sendError(res, 400, 'Empty request body');
      return;
    }

    // Parse request
    let chatRequest: ChatRequest;
    try {
      chatRequest = JSON.parse(body) as ChatRequest;
    } catch {
      this.sendError(res, 400, 'Invalid JSON');
      return;
    }

    // Validate request
    if (!chatRequest.message) {
      this.sendError(res, 400, 'Message is required');
      return;
    }

    const chatId = chatRequest.chatId || uuidv4();
    const messageId = uuidv4();
    const {userId} = chatRequest;
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
      } catch (error) {
        logger.error({ err: error, messageId }, 'Failed to handle message');
        this.sendError(res, 500, 'Failed to process message');
        return;
      }
    } else {
      logger.warn({ chatId, messageId }, 'No messageHandler registered');
    }

    // Prepare response
    const response: ChatResponse = {
      success: true,
      messageId,
      chatId,
    };

    if (syncMode) {
      // Wait for response with timeout (4 minutes for AI processing)
      const timeoutMs = 240000; // 240 seconds (4 minutes)

      // Issue #3193: Detect client disconnect and abort pending response.
      // When the client (e.g., curl with --max-time) disconnects due to its own
      // timeout, the server should stop waiting immediately to free resources
      // for subsequent requests.
      const clientDisconnected = new Promise<never>((_resolve, reject) => {
        res.on('close', () => {
          // res.close fires when the underlying connection is closed — either
          // because we ended the response (normal path) or the client dropped.
          // Only act if the response hasn't been sent yet (writableFinished).
          if (!res.writableFinished) {
            const elapsedMs = Date.now() - requestStartMs;
            logger.info(
              { chatId, messageId, elapsedMs },
              'Client disconnected before response was sent — aborting pending response'
            );
            reject(new Error('Client disconnected'));
          }
        });
      });

      try {
        const responseText = await Promise.race([
          this.waitForResponse(chatId, messageId, timeoutMs, requestStartMs),
          clientDisconnected,
        ]);
        response.response = responseText;

        // Issue #3003: log total request timing
        const totalMs = Date.now() - requestStartMs;
        logger.info(
          { chatId, messageId, totalMs, responseLength: responseText?.length ?? 0 },
          'Sync request completed'
        );
      } catch (error) {
        const elapsedMs = Date.now() - requestStartMs;
        // Client disconnected before we could respond — clean up silently.
        if (error instanceof Error && error.message === 'Client disconnected') {
          logger.info(
            { chatId, messageId, elapsedMs },
            'Sync request aborted — client already gone'
          );
          // Cleanup buffers so the agent loop's late messages don't leak.
          this.responseBuffers.delete(messageId);
          this.chatToMessage.delete(chatId);
          return; // Don't try to write to a closed socket.
        }
        // Re-throw other errors (e.g., timeout) to be handled by the caller.
        throw error;
      }

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
  private async handleAsyncChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    chatId: string
  ): Promise<void> {
    // Read request body
    const body = await this.readBody(req);

    // Parse request if body exists
    let chatRequest: { message?: string; userId?: string } | null = null;
    if (body) {
      try {
        chatRequest = JSON.parse(body) as { message?: string; userId?: string };
      } catch {
        this.sendError(res, 400, 'Invalid JSON');
        return;
      }
    }

    // Get or create session state
    let session = this.sessionStates.get(chatId);

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
      session = {
        chatId,
        status: 'pending',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      this.sessionStates.set(chatId, session);
    }

    // Add user message
    session.messages.push({
      id: messageId,
      role: 'user',
      content: chatRequest.message,
      timestamp: now,
    });
    session.lastMessageId = messageId;
    session.status = 'processing';
    session.updatedAt = now;

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
      } catch (error) {
        logger.error({ err: error, messageId }, 'Failed to handle async message');
        session.status = 'error';
        session.updatedAt = Date.now();
        this.sendError(res, 500, 'Failed to process message');
        return;
      }
    } else {
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
   * Handle control command request.
   */
  private async handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) {
      this.sendError(res, 400, 'Empty request body');
      return;
    }

    let command: ControlCommand;
    try {
      command = JSON.parse(body) as ControlCommand;
    } catch {
      this.sendError(res, 400, 'Invalid JSON');
      return;
    }

    if (!command.type || !command.chatId) {
      this.sendError(res, 400, 'type and chatId are required');
      return;
    }

    logger.info({ type: command.type, chatId: command.chatId }, 'Received control command');

    const response = await this.emitControl(command);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Wait for response in sync mode.
   */
  private waitForResponse(chatId: string, messageId: string, timeoutMs: number, requestStartMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(chatId);
        this.responseBuffers.delete(messageId);

        // Issue #3003: log detailed timing summary on timeout
        const elapsedMs = Date.now() - requestStartMs;
        logger.warn(
          { chatId, messageId, elapsedMs, timeoutMs, timeoutExceededBy: elapsedMs - timeoutMs },
          'Sync response timeout — no response received within timeout. '
          + 'Check server logs for this chatId to identify the slow stage.'
        );

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
  private readBody(req: http.IncomingMessage): Promise<string> {
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
  private sendError(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: message,
    }));
  }

  /**
   * Handle file upload request.
   */
  private async handleFileUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.fileStorage) {
      this.sendError(res, 500, 'File storage not initialized');
      return;
    }

    const body = await this.readBody(req);
    if (!body) {
      this.sendError(res, 400, 'Empty request body');
      return;
    }

    let uploadRequest: FileUploadRequest;
    try {
      uploadRequest = JSON.parse(body) as FileUploadRequest;
    } catch {
      this.sendError(res, 400, 'Invalid JSON');
      return;
    }

    // Validate request
    if (!uploadRequest.fileName) {
      this.sendError(res, 400, 'fileName is required');
      return;
    }
    if (!uploadRequest.content) {
      this.sendError(res, 400, 'content is required');
      return;
    }

    // Validate base64 content
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(uploadRequest.content.replace(/\s/g, ''))) {
      this.sendError(res, 400, 'Invalid base64 content');
      return;
    }

    try {
      const fileRef = await this.fileStorage.storeFromBase64(
        uploadRequest.content,
        uploadRequest.fileName,
        uploadRequest.mimeType,
        'user',
        uploadRequest.chatId
      );

      // Track file-to-chat mapping
      if (uploadRequest.chatId) {
        this.fileToChat.set(fileRef.id, uploadRequest.chatId);
      }

      logger.info({ fileId: fileRef.id, fileName: uploadRequest.fileName }, 'File uploaded');

      const response: FileUploadResponse = {
        success: true,
        file: fileRef,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      logger.error({ err: error }, 'Failed to store file');
      this.sendError(res, 500, 'Failed to store file');
    }
  }

  /**
   * Handle file info request.
   */
  private async handleFileInfo(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    fileId: string
  ): Promise<void> {
    // Satisfy require-await rule
    await Promise.resolve();

    if (!this.fileStorage) {
      this.sendError(res, 500, 'File storage not initialized');
      return;
    }

    const stored = this.fileStorage.get(fileId);
    if (!stored) {
      const response: FileInfoResponse = {
        success: false,
        error: 'File not found',
      };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    logger.info({ fileId }, 'File info requested');

    const response: FileInfoResponse = {
      success: true,
      file: stored.ref,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Handle file download request.
   */
  private async handleFileDownload(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    fileId: string,
  ): Promise<void> {
    if (!this.fileStorage) {
      this.sendError(res, 500, 'File storage not initialized');
      return;
    }

    const stored = this.fileStorage.get(fileId);
    if (!stored) {
      const response: FileDownloadResponse = {
        success: false,
        error: 'File not found',
      };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    try {
      const content = await this.fileStorage.getContent(fileId);

      logger.info({ fileId, size: content.length }, 'File downloaded');

      const response: FileDownloadResponse = {
        success: true,
        file: stored.ref,
        content,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      logger.error({ err: error, fileId }, 'Failed to read file content');
      this.sendError(res, 500, 'Failed to read file content');
    }
  }

  /**
   * Start the periodic session cleanup timer.
   * @see Issue #1263 - Session state memory leak fix
   */
  private startSessionCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupSessions();
    }, RestChannel.CLEANUP_INTERVAL_MS);

    // Prevent the timer from keeping the process alive
    this.cleanupTimer.unref();

    logger.info(
      { cleanupInterval: RestChannel.CLEANUP_INTERVAL_MS, sessionTtl: RestChannel.SESSION_TTL, maxSessions: RestChannel.MAX_SESSIONS },
      'Session cleanup timer started'
    );
  }

  /**
   * Stop the session cleanup timer.
   * @see Issue #1263 - Session state memory leak fix
   */
  private stopSessionCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      logger.info('Session cleanup timer stopped');
    }
  }

  /**
   * Clean up expired sessions and enforce max session limit.
   * This method is called periodically to prevent memory leaks.
   * @see Issue #1263 - Session state memory leak fix
   */
  private cleanupSessions(): void {
    const now = Date.now();
    let expiredCount = 0;
    let evictedCount = 0;

    // Remove expired sessions (TTL-based cleanup)
    for (const [chatId, session] of this.sessionStates) {
      if (now - session.updatedAt > RestChannel.SESSION_TTL) {
        this.sessionStates.delete(chatId);
        expiredCount++;
      }
    }

    // Enforce max sessions limit (LRU eviction)
    if (this.sessionStates.size > RestChannel.MAX_SESSIONS) {
      // Sort sessions by updatedAt (oldest first)
      const sortedSessions = Array.from(this.sessionStates.entries())
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

      const toEvict = sortedSessions.slice(0, this.sessionStates.size - RestChannel.MAX_SESSIONS);
      for (const [chatId] of toEvict) {
        this.sessionStates.delete(chatId);
        evictedCount++;
      }
    }

    if (expiredCount > 0 || evictedCount > 0) {
      logger.info(
        { expiredCount, evictedCount, remainingSessions: this.sessionStates.size },
        'Session cleanup completed'
      );
    }
  }

  /**
   * Get current session count (for monitoring/debugging).
   * @see Issue #1263 - Session state memory leak fix
   */
  getSessionCount(): number {
    return this.sessionStates.size;
  }
}
