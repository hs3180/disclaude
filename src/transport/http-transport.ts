/**
 * HttpTransport - HTTP-based transport for distributed deployment.
 *
 * This transport allows Communication Node and Execution Node to run
 * in separate processes, communicating via HTTP.
 *
 * Architecture:
 * ```
 * Communication Node                    Execution Node
 *      │                                     │
 *      │  POST /task ────────────────────────►
 *      │  { chatId, message, ... }           │
 *      │                                     │
 *      ◄───────────────────────── POST /callback/message
 *      │  { chatId, type, text, ... }        │
 * ```
 *
 * Usage:
 * ```typescript
 * // Execution Node (Server)
 * const transport = new HttpTransport({ mode: 'execution', port: 3001 });
 * transport.onTask(async (request) => {
 *   // Process task
 *   return { success: true, taskId: request.taskId };
 * });
 * await transport.start();
 *
 * // Communication Node (Client)
 * const transport = new HttpTransport({
 *   mode: 'communication',
 *   executionUrl: 'http://localhost:3001',
 *   callbackPort: 3002,
 * });
 * transport.onMessage(async (content) => {
 *   // Send to Feishu
 * });
 * await transport.start();
 * const response = await transport.sendTask({ ... });
 * ```
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { createLogger } from '../utils/logger.js';
import type {
  ITransport,
  TaskRequest,
  TaskResponse,
  TaskHandler,
  MessageContent,
  MessageHandler,
  ControlCommand,
  ControlResponse,
  ControlHandler,
} from './types.js';

/**
 * Configuration for HttpTransport.
 */
export interface HttpTransportConfig {
  /** Transport mode: 'execution' (server) or 'communication' (client) */
  mode: 'execution' | 'communication';

  /** Port for Execution Node server (default: 3001) */
  port?: number;

  /** Host for Execution Node server (default: 'localhost') */
  host?: string;

  /** URL of Execution Node (required for communication mode) */
  executionUrl?: string;

  /** Port for callback server in communication mode (default: port + 1) */
  callbackPort?: number;

  /** Host for callback server in communication mode */
  callbackHost?: string;

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Authentication token for securing requests */
  authToken?: string;
}

/**
 * HTTP request body for task submission.
 */
interface TaskRequestBody {
  taskId: string;
  chatId: string;
  message: string;
  messageId: string;
  senderOpenId?: string;
  context?: Record<string, unknown>;
}

/**
 * HTTP request body for message callback.
 */
interface MessageCallbackBody {
  chatId: string;
  type: 'text' | 'card' | 'file';
  text?: string;
  card?: Record<string, unknown>;
  filePath?: string;
  description?: string;
}

/**
 * HTTP request body for control command.
 */
interface ControlRequestBody {
  type: 'reset' | 'restart';
  chatId: string;
  data?: Record<string, unknown>;
}

/**
 * HttpTransport implements ITransport for distributed deployment.
 *
 * In execution mode:
 * - Starts HTTP server to receive tasks
 * - Sends messages via POST callbacks to communication node
 *
 * In communication mode:
 * - Sends tasks via HTTP POST to execution node
 * - Starts HTTP server to receive message callbacks
 */
export class HttpTransport implements ITransport {
  private config: HttpTransportConfig;
  private taskHandler?: TaskHandler;
  private messageHandler?: MessageHandler;
  private controlHandler?: ControlHandler;
  private running = false;
  private logger = createLogger('HttpTransport');

  // HTTP servers
  private mainServer?: http.Server;
  private callbackServer?: http.Server;

  constructor(config: HttpTransportConfig) {
    this.config = {
      port: 3001,
      host: 'localhost',
      timeout: 30000,
      ...config,
    };

    // Set default callback port
    if (!this.config.callbackPort) {
      this.config.callbackPort = (this.config.port || 3001) + 1;
    }

    this.logger.info(
      {
        mode: this.config.mode,
        port: this.config.port,
        callbackPort: this.config.callbackPort,
        executionUrl: this.config.executionUrl,
      },
      'HttpTransport created'
    );
  }

  /**
   * Start the transport.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('HttpTransport already running');
      return;
    }

    if (this.config.mode === 'execution') {
      await this.startExecutionServer();
    } else {
      await this.startCallbackServer();
    }

    this.running = true;
    this.logger.info({ mode: this.config.mode }, 'HttpTransport started');
  }

  /**
   * Stop the transport.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Stop servers
    const stopServer = (server: http.Server | undefined): Promise<void> => {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    };

    await Promise.all([
      stopServer(this.mainServer),
      stopServer(this.callbackServer),
    ]);

    this.logger.info('HttpTransport stopped');
  }

  /**
   * Send a task to the Execution Node.
   * Only available in communication mode.
   */
  async sendTask(request: TaskRequest): Promise<TaskResponse> {
    if (this.config.mode !== 'communication') {
      this.logger.error('sendTask called in execution mode');
      return {
        success: false,
        error: 'sendTask not available in execution mode',
        taskId: request.taskId,
      };
    }

    if (!this.config.executionUrl) {
      this.logger.error('Execution URL not configured');
      return {
        success: false,
        error: 'Execution URL not configured',
        taskId: request.taskId,
      };
    }

    try {
      const response = await this.httpPost(
        `${this.config.executionUrl}/task`,
        {
          taskId: request.taskId,
          chatId: request.chatId,
          message: request.message,
          messageId: request.messageId,
          senderOpenId: request.senderOpenId,
          context: request.context,
        }
      );

      return response as TaskResponse;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, taskId: request.taskId }, 'Failed to send task');
      return {
        success: false,
        error: err.message,
        taskId: request.taskId,
      };
    }
  }

  /**
   * Register a handler for incoming tasks.
   * Only available in execution mode.
   */
  onTask(handler: TaskHandler): void {
    if (this.config.mode !== 'execution') {
      this.logger.warn('onTask called in communication mode - handler will not be used');
    }
    this.taskHandler = handler;
    this.logger.debug('Task handler registered');
  }

  /**
   * Send a message to the Communication Node.
   * Only available in execution mode.
   */
  async sendMessage(content: MessageContent): Promise<void> {
    if (this.config.mode !== 'execution') {
      this.logger.error('sendMessage called in communication mode');
      throw new Error('sendMessage not available in communication mode');
    }

    if (!this.messageHandler) {
      // In HTTP mode, we need to POST to callback URL
      // For now, we'll use the handler if registered
      this.logger.warn('No message handler registered for HTTP callback');
      return;
    }

    // In single-process mode with HTTP transport, call the handler directly
    // In true distributed mode, this should POST to communication node's callback URL
    await this.messageHandler(content);
  }

  /**
   * Register a handler for incoming messages.
   * Only available in communication mode.
   */
  onMessage(handler: MessageHandler): void {
    if (this.config.mode !== 'communication') {
      this.logger.warn('onMessage called in execution mode - handler will not be used');
    }
    this.messageHandler = handler;
    this.logger.debug('Message handler registered');
  }

  /**
   * Send a control command to the Execution Node.
   * Only available in communication mode.
   */
  async sendControl(command: ControlCommand): Promise<ControlResponse> {
    if (this.config.mode !== 'communication') {
      return {
        success: false,
        error: 'sendControl not available in execution mode',
        type: command.type,
      };
    }

    if (!this.config.executionUrl) {
      return {
        success: false,
        error: 'Execution URL not configured',
        type: command.type,
      };
    }

    try {
      const response = await this.httpPost(
        `${this.config.executionUrl}/control`,
        {
          type: command.type,
          chatId: command.chatId,
          data: command.data,
        }
      );

      return response as ControlResponse;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, type: command.type }, 'Failed to send control command');
      return {
        success: false,
        error: err.message,
        type: command.type,
      };
    }
  }

  /**
   * Register a handler for incoming control commands.
   * Only available in execution mode.
   */
  onControl(handler: ControlHandler): void {
    if (this.config.mode !== 'execution') {
      this.logger.warn('onControl called in communication mode - handler will not be used');
    }
    this.controlHandler = handler;
    this.logger.debug('Control handler registered');
  }

  /**
   * Check if the transport is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ==================== Private Methods ====================

  /**
   * Start HTTP server for Execution Node.
   */
  private async startExecutionServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.mainServer = http.createServer((req, res) => {
        this.handleExecutionRequest(req, res);
      });

      this.mainServer.on('error', (err) => {
        this.logger.error({ err }, 'Execution server error');
        reject(err);
      });

      this.mainServer.listen(this.config.port, this.config.host, () => {
        this.logger.info(
          { port: this.config.port, host: this.config.host },
          'Execution server listening'
        );
        resolve();
      });
    });
  }

  /**
   * Start HTTP callback server for Communication Node.
   */
  private async startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer((req, res) => {
        this.handleCallbackRequest(req, res);
      });

      this.callbackServer.on('error', (err) => {
        this.logger.error({ err }, 'Callback server error');
        reject(err);
      });

      const port = this.config.callbackPort!;
      this.callbackServer.listen(port, this.config.host, () => {
        this.logger.info(
          { port, host: this.config.host },
          'Callback server listening'
        );
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP request for Execution Node.
   */
  private async handleExecutionRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    this.logger.debug({ method: req.method, path }, 'Received request');

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Verify auth token if configured
    if (this.config.authToken) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${this.config.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      if (req.method === 'POST' && path === '/task') {
        await this.handleTaskRequest(req, res);
      } else if (req.method === 'POST' && path === '/control') {
        await this.handleControlRequest(req, res);
      } else if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'execution' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, path }, 'Request handler error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle incoming HTTP request for Communication Node callback.
   */
  private async handleCallbackRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    this.logger.debug({ method: req.method, path }, 'Received callback request');

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Verify auth token if configured
    if (this.config.authToken) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${this.config.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      if (req.method === 'POST' && path === '/callback/message') {
        await this.handleMessageCallback(req, res);
      } else if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'communication' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, path }, 'Callback handler error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle task request on Execution Node.
   */
  private async handleTaskRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readJsonBody<TaskRequestBody>(req);

    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
      return;
    }

    this.logger.info(
      { taskId: body.taskId, chatId: body.chatId },
      'Received task request via HTTP'
    );

    if (!this.taskHandler) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'No task handler registered',
        taskId: body.taskId,
      }));
      return;
    }

    try {
      const response = await this.taskHandler({
        taskId: body.taskId,
        chatId: body.chatId,
        message: body.message,
        messageId: body.messageId,
        senderOpenId: body.senderOpenId,
        context: body.context,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      const err = error as Error;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message,
        taskId: body.taskId,
      }));
    }
  }

  /**
   * Handle control request on Execution Node.
   */
  private async handleControlRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readJsonBody<ControlRequestBody>(req);

    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
      return;
    }

    this.logger.info(
      { type: body.type, chatId: body.chatId },
      'Received control request via HTTP'
    );

    if (!this.controlHandler) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'No control handler registered',
        type: body.type,
      }));
      return;
    }

    try {
      const response = await this.controlHandler({
        type: body.type,
        chatId: body.chatId,
        data: body.data,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      const err = error as Error;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message,
        type: body.type,
      }));
    }
  }

  /**
   * Handle message callback on Communication Node.
   */
  private async handleMessageCallback(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readJsonBody<MessageCallbackBody>(req);

    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
      return;
    }

    this.logger.info(
      { chatId: body.chatId, type: body.type },
      'Received message callback via HTTP'
    );

    if (!this.messageHandler) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No message handler registered' }));
      return;
    }

    try {
      await this.messageHandler({
        chatId: body.chatId,
        type: body.type,
        text: body.text,
        card: body.card,
        filePath: body.filePath,
        description: body.description,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      const err = error as Error;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Read JSON body from HTTP request.
   */
  private readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          if (body) {
            resolve(JSON.parse(body) as T);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => {
        resolve(null);
      });
    });
  }

  /**
   * Make HTTP POST request.
   */
  private httpPost<T>(url: string, data: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const body = JSON.stringify(data);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: this.config.timeout,
      };

      // Add auth header if configured
      if (this.config.authToken) {
        (options.headers as Record<string, string>)['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      const req = http.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(responseBody) as T);
            } else {
              const error = JSON.parse(responseBody);
              reject(new Error(error.error || `HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }
}
