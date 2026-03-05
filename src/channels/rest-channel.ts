/**
 * REST Channel Implementation.
 *
 * Provides a RESTful API for sending messages to the agent.
 * Users can make HTTP POST requests to interact with the agent.
 *
 * API Endpoints:
 * - POST /api/chat - Send a message (non-blocking, returns messageId)
 * - GET /api/chat/{chatId}/status - Get session status
 * - GET /api/chat/{chatId}/messages - Get session messages
 * - GET /api/health - Health check
 * - POST /api/files/upload - Upload a file (base64 encoded)
 * - GET /api/files/:fileId - Get file metadata
 * - GET /api/files/:fileId/download - Download a file (base64 encoded)
 *
 * @see Issue #583 - REST Channel file transfer
 * @see Issue #738 - Refactor to non-blocking async mode
 */

import http from 'node:http';
import { createLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { BaseChannel } from './base-channel.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  ControlCommand,
  ChannelCapabilities,
} from './types.js';
import {
  FileStorageService,
  type FileRef,
} from '../file-transfer/index.js';

const logger = createLogger('RestChannel');

/**
 * REST channel configuration.
 */
export interface RestChannelConfig extends ChannelConfig {
  /** Server port (default: 3000) */
  port?: number;
  /** Server host (default: 0.0.0.0) */
  host?: string;
  /** API prefix (default: /api) */
  apiPrefix?: string;
  /** Authentication token (optional) */
  authToken?: string;
  /** Enable CORS (default: true) */
  enableCors?: boolean;
  /** File storage directory (default: ./data/rest-files) */
  fileStorageDir?: string;
  /** Maximum file size in bytes (default: 100MB) */
  maxFileSize?: number;
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
  /** Session status */
  status?: SessionStatus;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Session status type.
 */
type SessionStatus = 'pending' | 'processing' | 'completed' | 'error';

/**
 * Stored message in a session.
 */
interface StoredMessage {
  /** Message ID */
  id: string;
  /** Role: user or assistant */
  role: 'user' | 'assistant';
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Session state for tracking chat sessions.
 */
interface SessionState {
  /** Chat ID */
  chatId: string;
  /** Current status */
  status: SessionStatus;
  /** Last message ID */
  lastMessageId?: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** Error message (if status is error) */
  error?: string;
  /** Messages in this session */
  messages: StoredMessage[];
}

/**
 * Session status response.
 */
interface SessionStatusResponse {
  /** Success status */
  success: boolean;
  /** Chat ID */
  chatId?: string;
  /** Session status */
  status?: SessionStatus;
  /** Last message ID */
  lastMessageId?: string;
  /** Last updated timestamp */
  updatedAt?: string;
  /** Error message */
  error?: string;
}

/**
 * Session messages response.
 */
interface SessionMessagesResponse {
  /** Success status */
  success: boolean;
  /** Chat ID */
  chatId?: string;
  /** Messages */
  messages?: StoredMessage[];
  /** Error message */
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
 * REST Channel - Provides RESTful API for agent interaction.
 *
 * Features:
 * - POST /api/chat - Send message (non-blocking, returns messageId)
 * - GET /api/chat/{chatId}/status - Get session status
 * - GET /api/chat/{chatId}/messages - Get session messages
 * - GET /api/health - Health check
 * - POST /api/files/upload - Upload a file
 * - GET /api/files/:fileId - Get file metadata
 * - GET /api/files/:fileId/download - Download a file
 * - Optional authentication via Authorization header
 * - CORS support
 */
export class RestChannel extends BaseChannel<RestChannelConfig> {
  private port: number;
  private host: string;
  private apiPrefix: string;
  private authToken?: string;
  private enableCors: boolean;
  private fileStorageDir: string;
  private maxFileSize: number;

  private server?: http.Server;
  private fileStorage?: FileStorageService;

  // Session storage (chatId -> SessionState)
  private sessions = new Map<string, SessionState>();
  // File ID to Chat ID mapping (for file uploads)
  private fileToChat = new Map<string, string>();

  constructor(config: RestChannelConfig = {}) {
    super(config, 'rest', 'REST');
    this.port = config.port || 3000;
    this.host = config.host || '0.0.0.0';
    this.apiPrefix = config.apiPrefix || '/api';
    this.authToken = config.authToken;
    this.enableCors = config.enableCors ?? true;
    this.fileStorageDir = config.fileStorageDir || './data/rest-files';
    this.maxFileSize = config.maxFileSize ?? 100 * 1024 * 1024; // 100MB

    logger.info({ id: this.id, port: this.port }, 'RestChannel created');
  }

  protected async doStart(): Promise<void> {
    // Initialize file storage service
    this.fileStorage = new FileStorageService({
      storageDir: this.fileStorageDir,
      maxFileSize: this.maxFileSize,
    });
    await this.fileStorage.initialize();
    logger.info({ storageDir: this.fileStorageDir }, 'File storage initialized');

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        logger.error({ err: error }, 'Failed to handle request');
        this.sendError(res, 500, 'Internal server error');
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        logger.info({ port: this.port, host: this.host }, 'RestChannel started');
        resolve();
      });

      this.server!.on('error', (error) => {
        logger.error({ err: error }, 'Failed to start RestChannel');
        reject(error);
      });
    });
  }

  protected doStop(): Promise<void> {
    // Clear all sessions
    this.sessions.clear();
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
      } else {
        resolve();
      }
    });
  }

  protected doSendMessage(message: OutgoingMessage): Promise<void> {
    const session = this.sessions.get(message.chatId);
    if (!session) {
      logger.warn({ chatId: message.chatId }, 'No session found for outgoing message');
      return Promise.resolve();
    }

    // Handle 'done' type - task completion signal
    if (message.type === 'done') {
      if (message.success === false || message.error) {
        session.status = 'error';
        session.error = message.error || 'Task failed';
      } else {
        session.status = 'completed';
      }
      session.updatedAt = new Date().toISOString();
      logger.info({ chatId: message.chatId }, 'Session completed');
      return Promise.resolve();
    }

    // Handle 'text' type - store assistant response
    if (message.type === 'text' && message.text) {
      const assistantMessage: StoredMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: message.text,
        timestamp: new Date().toISOString(),
      };
      session.messages.push(assistantMessage);
      session.lastMessageId = assistantMessage.id;
      session.updatedAt = new Date().toISOString();
    }

    return Promise.resolve();
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
      supportedMcpTools: ['send_user_feedback'],
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
    // Set CORS headers if enabled
    if (this.enableCors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Check authentication
    if (this.authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${this.authToken}`) {
        this.sendError(res, 401, 'Unauthorized');
        return;
      }
    }

    const url = req.url?.split('?')[0] || '/';

    // Route requests
    if (url === `${this.apiPrefix}/health` && req.method === 'GET') {
      this.handleHealth(req, res);
      return;
    }

    if (url === `${this.apiPrefix}/chat` && req.method === 'POST') {
      await this.handleChat(req, res);
      return;
    }

    // Chat session status endpoint
    const statusMatch = url.match(new RegExp(`^${this.apiPrefix}/chat/([^/]+)/status$`));
    if (statusMatch && req.method === 'GET') {
      await this.handleSessionStatus(req, res, statusMatch[1]);
      return;
    }

    // Chat session messages endpoint
    const messagesMatch = url.match(new RegExp(`^${this.apiPrefix}/chat/([^/]+)/messages$`));
    if (messagesMatch && req.method === 'GET') {
      await this.handleSessionMessages(req, res, messagesMatch[1]);
      return;
    }

    // Control endpoints
    if (url === `${this.apiPrefix}/control` && req.method === 'POST') {
      await this.handleControl(req, res);
      return;
    }

    // File upload endpoint
    if (url === `${this.apiPrefix}/files/upload` && req.method === 'POST') {
      await this.handleFileUpload(req, res);
      return;
    }

    // File info and download endpoints
    const fileMatch = url.match(new RegExp(`^${this.apiPrefix}/files/([^/]+)(/download)?$`));
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
   * Handle chat request (non-blocking).
   */
  private async handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse
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
    const { userId } = chatRequest;

    logger.info({ chatId, messageId, userId }, 'Received chat request');

    // Create or update session
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        chatId,
        status: 'pending',
        messages: [],
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(chatId, session);
    }

    // Store user message
    const userMessage: StoredMessage = {
      id: messageId,
      role: 'user',
      content: chatRequest.message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMessage);
    session.lastMessageId = messageId;
    session.status = 'processing';
    session.updatedAt = new Date().toISOString();

    // Emit as incoming message
    if (this.messageHandler) {
      try {
        await this.messageHandler({
          messageId,
          chatId,
          userId,
          content: chatRequest.message,
          messageType: 'text',
          timestamp: Date.now(),
          threadId: chatRequest.threadId,
        });
      } catch (error) {
        logger.error({ err: error, messageId }, 'Failed to handle message');
        session.status = 'error';
        session.error = 'Failed to process message';
        session.updatedAt = new Date().toISOString();
        this.sendError(res, 500, 'Failed to process message');
        return;
      }
    } else {
      logger.warn({ chatId, messageId }, 'No messageHandler registered');
    }

    // Prepare non-blocking response
    const response: ChatResponse = {
      success: true,
      messageId,
      chatId,
      status: session.status,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Handle session status request.
   */
  private async handleSessionStatus(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    chatId: string
  ): Promise<void> {
    const session = this.sessions.get(chatId);

    if (!session) {
      const response: SessionStatusResponse = {
        success: false,
        error: 'Session not found',
      };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    const response: SessionStatusResponse = {
      success: true,
      chatId: session.chatId,
      status: session.status,
      lastMessageId: session.lastMessageId,
      updatedAt: session.updatedAt,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Handle session messages request.
   */
  private async handleSessionMessages(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    chatId: string
  ): Promise<void> {
    const session = this.sessions.get(chatId);

    if (!session) {
      const response: SessionMessagesResponse = {
        success: false,
        error: 'Session not found',
      };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    const response: SessionMessagesResponse = {
      success: true,
      chatId: session.chatId,
      messages: session.messages,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
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
    fileId: string
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
}
