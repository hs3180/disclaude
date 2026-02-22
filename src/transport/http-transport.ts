/**
 * HttpTransport - HTTP-based transport for distributed deployment.
 *
 * This transport allows Communication Node and Execution Node to run
 * in separate processes, communicating via HTTP.
 *
 * Architecture:
 * ```
 * Communication Node (Server)              Execution Node (Client)
 *      │                                         │
 *      ◄─────────────────────────── POST /task ───
 *      │  { chatId, message, ... }               │
 *      │                                         │
 *      │  POST /callback ────────────────────────►
 *      │  { chatId, type, text, ... }            │
 * ```
 *
 * Communication Node runs HTTP server, Execution Node connects as client.
 * This allows Execution Node to be deployed anywhere and connect to
 * the Communication Node.
 *
 * Usage:
 * ```typescript
 * // Communication Node (Server)
 * const transport = new HttpTransport({ mode: 'communication', port: 3001 });
 * transport.onTask(async (request) => {
 *   // Process incoming task
 *   return { success: true, taskId: request.taskId };
 * });
 * await transport.start();
 *
 * // Execution Node (Client)
 * const transport = new HttpTransport({
 *   mode: 'execution',
 *   communicationUrl: 'http://localhost:3001',
 * });
 * transport.onMessage(async (content) => {
 *   // Handle message callback
 * });
 * await transport.start();
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
  /** Transport mode: 'communication' (server) or 'execution' (client) */
  mode: 'communication' | 'execution';

  /** Port for Communication Node server (default: 3001) */
  port?: number;

  /** Host for Communication Node server (default: '0.0.0.0' for external access) */
  host?: string;

  /** URL of Communication Node (required for execution mode) */
  communicationUrl?: string;

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Authentication token for securing requests */
  authToken?: string;
}

/**
 * HTTP request body for task submission (from Feishu).
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
 * HTTP request body for message callback (from Execution Node).
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
 * HTTP request body for control command (from Feishu).
 */
interface ControlRequestBody {
  type: 'reset' | 'restart';
  chatId: string;
  data?: Record<string, unknown>;
}

/**
 * HttpTransport implements ITransport for distributed deployment.
 *
 * In communication mode:
 * - Starts HTTP server to receive tasks from Feishu
 * - Receives message callbacks from Execution Node via POST
 *
 * In execution mode:
 * - Connects to Communication Node as HTTP client
 * - Sends messages via HTTP POST to Communication Node
 */
export class HttpTransport implements ITransport {
  private config: Required<Omit<HttpTransportConfig, 'communicationUrl' | 'authToken'>> & {
    communicationUrl?: string;
    authToken?: string;
  };
  private taskHandler?: TaskHandler;
  private messageHandler?: MessageHandler;
  private controlHandler?: ControlHandler;
  private running = false;
  private logger = createLogger('HttpTransport');

  // HTTP server for communication mode
  private server?: http.Server;

  constructor(config: HttpTransportConfig) {
    this.config = {
      mode: config.mode,
      port: config.port ?? 3001,
      host: config.host ?? '0.0.0.0',
      timeout: config.timeout ?? 30000,
      communicationUrl: config.communicationUrl,
      authToken: config.authToken,
    };

    this.logger.info(
      {
        mode: this.config.mode,
        port: this.config.port,
        host: this.config.host,
        communicationUrl: this.config.communicationUrl,
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

    if (this.config.mode === 'communication') {
      await this.startServer();
    }
    // Execution mode doesn't need a server, just connects as client

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

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    this.logger.info('HttpTransport stopped');
  }

  // ==================== ITransport Interface ====================

  /**
   * Send a task request.
   *
   * In communication mode: Not used (tasks come from Feishu via HTTP)
   * In execution mode: Not applicable (Execution Node receives tasks)
   */
  async sendTask(request: TaskRequest): Promise<TaskResponse> {
    // This method is for compatibility with ITransport
    // In HTTP mode, tasks flow differently:
    // - Communication mode: receives tasks via HTTP server
    // - Execution mode: doesn't send tasks
    this.logger.warn('sendTask called in HTTP mode - tasks flow via HTTP');
    return {
      success: false,
      error: 'sendTask not applicable in HTTP mode',
      taskId: request.taskId,
    };
  }

  /**
   * Register a handler for incoming tasks.
   * In communication mode, this handles tasks from Feishu (received via HTTP).
   */
  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
    this.logger.debug('Task handler registered');
  }

  /**
   * Send a message.
   *
   * In communication mode: Receives from Execution Node via HTTP POST
   * In execution mode: POSTs to Communication Node
   */
  async sendMessage(content: MessageContent): Promise<void> {
    if (this.config.mode === 'execution') {
      // Execution mode: POST to Communication Node
      if (!this.config.communicationUrl) {
        this.logger.error('Communication URL not configured');
        throw new Error('Communication URL not configured');
      }

      await this.httpPost(`${this.config.communicationUrl}/callback`, {
        chatId: content.chatId,
        type: content.type,
        text: content.text,
        card: content.card,
        filePath: content.filePath,
        description: content.description,
      });
    } else {
      // Communication mode: call registered handler
      if (!this.messageHandler) {
        this.logger.warn('No message handler registered');
        return;
      }
      await this.messageHandler(content);
    }
  }

  /**
   * Register a handler for incoming messages.
   * In communication mode, this handles messages from Execution Node.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    this.logger.debug('Message handler registered');
  }

  /**
   * Send a control command.
   *
   * In communication mode: handles /reset locally
   * In execution mode: receives from Communication Node
   */
  async sendControl(command: ControlCommand): Promise<ControlResponse> {
    if (this.config.mode === 'communication') {
      // Communication mode: handle locally
      if (!this.controlHandler) {
        return {
          success: false,
          error: 'No control handler registered',
          type: command.type,
        };
      }
      return await this.controlHandler(command);
    } else {
      // Execution mode: POST to Communication Node
      if (!this.config.communicationUrl) {
        return {
          success: false,
          error: 'Communication URL not configured',
          type: command.type,
        };
      }

      try {
        const response = await this.httpPost(`${this.config.communicationUrl}/control`, {
          type: command.type,
          chatId: command.chatId,
          data: command.data,
        });
        return response as ControlResponse;
      } catch (error) {
        const err = error as Error;
        return {
          success: false,
          error: err.message,
          type: command.type,
        };
      }
    }
  }

  /**
   * Register a handler for incoming control commands.
   * In communication mode, this handles /reset commands.
   */
  onControl(handler: ControlHandler): void {
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
   * Start HTTP server for Communication Node.
   */
  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        this.logger.error({ err }, 'Server error');
        reject(err);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info(
          { port: this.config.port, host: this.config.host },
          'Communication server listening'
        );
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
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
      } else if (req.method === 'POST' && path === '/callback') {
        await this.handleCallbackRequest(req, res);
      } else if (req.method === 'POST' && path === '/control') {
        await this.handleControlRequest(req, res);
      } else if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'communication' }));
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
   * Handle task request from Execution Node.
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
   * Handle message callback from Execution Node.
   */
  private async handleCallbackRequest(
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
   * Handle control request from Execution Node.
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
