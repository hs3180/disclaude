/**
 * REST Channel Implementation.
 *
 * Provides a RESTful API for sending messages to the agent.
 * Users can make HTTP POST requests to interact with the agent.
 *
 * API Endpoints:
 * - POST /api/chat - Send a message and receive response (streaming)
 * - POST /api/chat/sync - Send a message and wait for complete response
 * - GET /api/health - Health check
 */

import http from 'node:http';
import { createLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { BaseChannel } from './base-channel.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  ControlCommand,
} from './types.js';

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
 * Pending response for sync mode.
 */
interface PendingResponse {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  response: string[];
  timeout: NodeJS.Timeout;
}

/**
 * REST Channel - Provides RESTful API for agent interaction.
 *
 * Features:
 * - POST /api/chat - Send message (streaming response)
 * - POST /api/chat/sync - Send message (synchronous response)
 * - GET /api/health - Health check
 * - Optional authentication via Authorization header
 * - CORS support
 */
export class RestChannel extends BaseChannel<RestChannelConfig> {
  private port: number;
  private host: string;
  private apiPrefix: string;
  private authToken?: string;
  private enableCors: boolean;

  private server?: http.Server;

  // Pending responses for sync mode (chatId -> PendingResponse)
  private pendingResponses = new Map<string, PendingResponse>();
  // Response buffers for sync mode (messageId -> response text)
  private responseBuffers = new Map<string, string[]>();
  // Chat ID to message ID mapping
  private chatToMessage = new Map<string, string>();

  constructor(config: RestChannelConfig = {}) {
    super(config, 'rest', 'REST');
    this.port = config.port || 3000;
    this.host = config.host || '0.0.0.0';
    this.apiPrefix = config.apiPrefix || '/api';
    this.authToken = config.authToken;
    this.enableCors = config.enableCors ?? true;

    logger.info({ id: this.id, port: this.port }, 'RestChannel created');
  }

  protected doStart(): Promise<void> {
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
    // Clear all pending responses
    for (const [_chatId, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Channel stopped'));
    }
    this.pendingResponses.clear();
    this.responseBuffers.clear();
    this.chatToMessage.clear();

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
    const messageId = this.chatToMessage.get(message.chatId);

    // Handle 'done' type - task completion signal for sync mode
    if (message.type === 'done') {
      const pending = this.pendingResponses.get(message.chatId);
      if (pending) {
        // Get buffered response
        const buffer = messageId ? this.responseBuffers.get(messageId) : undefined;
        const responseText = buffer ? buffer.join('\n') : '';

        logger.info(
          { chatId: message.chatId, messageId, responseLength: responseText.length },
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
      } else {
        logger.warn(
          { chatId: message.chatId, messageId },
          'Received done but no pending response found'
        );
      }
      return Promise.resolve();
    }

    // For sync mode: buffer text responses
    if (messageId && message.type === 'text') {
      const buffer = this.responseBuffers.get(messageId);
      if (buffer) {
        buffer.push(message.text || '');
      } else {
        logger.warn(
          { chatId: message.chatId, messageId },
          'No buffer found for text message'
        );
      }
    }
  }

  protected checkHealth(): boolean {
    return this.server !== undefined;
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
      await this.handleChat(req, res, false);
      return;
    }

    if (url === `${this.apiPrefix}/chat/sync` && req.method === 'POST') {
      await this.handleChat(req, res, true);
      return;
    }

    // Control endpoints
    if (url === `${this.apiPrefix}/control` && req.method === 'POST') {
      await this.handleControl(req, res);
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

    logger.info({ chatId, messageId, userId, syncMode }, 'Received chat request');

    // For sync mode, set up response handling
    if (syncMode) {
      this.responseBuffers.set(messageId, []);
      this.chatToMessage.set(chatId, messageId);
    }

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
      const responseText = await this.waitForResponse(chatId, messageId, timeoutMs);
      response.response = responseText;

      // Cleanup
      this.responseBuffers.delete(messageId);
      this.chatToMessage.delete(chatId);
    }

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
   * Wait for response in sync mode.
   */
  private waitForResponse(chatId: string, messageId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(chatId);
        this.responseBuffers.delete(messageId);
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
}
