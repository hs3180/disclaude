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
 *
 * Future endpoints (not yet implemented):
 * - `POST /api/push` — Push message to agent (equivalent to push_to_agent)
 * - API Token authentication
 *
 * @module primary-node/http-api-server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '@disclaude/core';
import { PRIMARY_NODE_VERSION } from './index.js';

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
