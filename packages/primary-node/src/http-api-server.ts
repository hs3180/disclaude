/**
 * HTTP API Server for Primary Node.
 *
 * Provides a lightweight HTTP server for external tools (CLI, scripts) to
 * interact with Primary Node without going through Channel MCP.
 *
 * Phase 2 of Issue #3857: Primary Node HTTP API.
 *
 * Endpoints:
 * - `GET /api/status` — Basic health/status check
 * - `POST /api/push` — Push message to agent (equivalent to push_to_agent)
 *
 * Future endpoints (not yet implemented):
 * - API Token authentication
 *
 * @module primary-node/http-api-server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '@disclaude/core';
import { PRIMARY_NODE_VERSION } from './version.js';

const logger = createLogger('HttpApiServer');

/**
 * Configuration for the HTTP API server.
 */
export interface HttpApiServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** API token for authentication (future use) */
  apiToken?: string;
}

/**
 * Status response returned by GET /api/status.
 */
export interface StatusResponse {
  /** Server status */
  status: 'ok' | 'error';
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** Node identifier */
  nodeId?: string;
  /** Uptime in seconds */
  uptime: number;
  /** Version info */
  version: string;
}

/**
 * Push response returned by POST /api/push.
 */
export interface PushResponse {
  /** Whether the push was accepted */
  ok: boolean;
  /** Descriptive message */
  message: string;
}

/**
 * Handler for push requests. Routes a message to the appropriate agent.
 */
export type PushHandler = (chatId: string, message: string) => Promise<void>;

/**
 * Route handler type.
 */
type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

/**
 * Simple route definition.
 */
interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * HTTP API Server — lightweight HTTP interface for Primary Node.
 *
 * Uses Node.js built-in `http` module (no external dependencies).
 * Supports simple pattern-based routing with named parameters.
 *
 * @example
 * ```typescript
 * const server = new HttpApiServer({ port: 9200 });
 * server.start();
 * // GET http://localhost:9200/api/status → { status: "ok", ... }
 * ```
 */
export class HttpApiServer {
  private readonly config: HttpApiServerConfig;
  private readonly routes: Route[] = [];
  private server: Server | null = null;
  private startTime = 0;
  private nodeId?: string;
  private pushHandler?: PushHandler;

  constructor(config: HttpApiServerConfig) {
    this.config = { host: 'localhost', ...config };
    this.setupRoutes();
  }

  /**
   * Set the node identifier for status responses.
   */
  setNodeId(nodeId: string): void {
    this.nodeId = nodeId;
  }

  /**
   * Set the push handler for POST /api/push.
   *
   * The handler receives a chatId and message string, and routes them
   * to the appropriate agent via InputMessageRouter.
   */
  setPushHandler(handler: PushHandler): void {
    this.pushHandler = handler;
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('HTTP API server already running');
      return;
    }

    this.startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      let listening = false;

      this.server.once('error', (err: NodeJS.ErrnoException) => {
        if (!listening) {
          if (err.code === 'EADDRINUSE') {
            logger.error({ port: this.config.port }, 'Port already in use');
          }
          reject(err);
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        listening = true;
        logger.info(
          { port: this.config.port, host: this.config.host },
          'HTTP API server listening',
        );
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const serverToClose = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      serverToClose.close((err) => {
        if (err) {
          reject(err);
        } else {
          logger.info('HTTP API server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Whether the server is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Register a route.
   */
  private addRoute(
    method: string,
    pattern: string,
    handler: RouteHandler,
  ): void {
    // Convert pattern like "/api/status" or "/api/chat/:chatId" to regex
    const paramNames: string[] = [];
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
  private setupRoutes(): void {
    this.addRoute('GET', '/api/status', this.handleStatus.bind(this));
    this.addRoute('POST', '/api/push', this.handlePush.bind(this));
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        if (authHeader !== `Bearer ${this.config.apiToken}`) {
          this.sendJson(res, 401, { error: 'Unauthorized', message: 'Invalid or missing API token' });
          return;
        }
      }

      // Extract named parameters
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1];
      }

      try {
        await route.handler(req, res, params);
      } catch (err) {
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
  private handleStatus(
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
  ): Promise<void> {
    const response: StatusResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      nodeId: this.nodeId,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: PRIMARY_NODE_VERSION,
    };
    this.sendJson(res, 200, response);
    return Promise.resolve();
  }

  /**
   * POST /api/push handler.
   *
   * Accepts `{ chatId: string, message: string }` and routes the message
   * to the agent via the configured PushHandler.
   */
  private async handlePush(
    req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
  ): Promise<void> {
    if (!this.pushHandler) {
      this.sendJson(res, 503, { ok: false, message: 'Push handler not configured' });
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' });
      return;
    }

    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof (parsed as Record<string, unknown>).chatId !== 'string' ||
      typeof (parsed as Record<string, unknown>).message !== 'string'
    ) {
      this.sendJson(res, 400, { ok: false, message: 'Required fields: chatId (string), message (string)' });
      return;
    }

    const { chatId, message } = parsed as { chatId: string; message: string };

    if (!chatId || !message) {
      this.sendJson(res, 400, { ok: false, message: 'chatId and message must be non-empty' });
      return;
    }

    try {
      await this.pushHandler(chatId, message);
      this.sendJson(res, 200, { ok: true, message: 'Push accepted' });
    } catch (err) {
      logger.error({ err, chatId }, 'Push handler error');
      const msg = err instanceof Error ? err.message : 'Push failed';
      this.sendJson(res, 500, { ok: false, message: msg });
    }
  }

  /**
   * Send a JSON response.
   */
  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
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
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) { return; }
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
