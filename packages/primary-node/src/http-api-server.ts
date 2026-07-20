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
 * - `GET /api/ping` — Liveness probe (`{ pong: true }`); REST parity with IPC `ping` (#4279)
 * - `POST /api/push` — Push message to agent (equivalent to push_to_agent)
 * - `POST /api/send-message` — Send a text message to a chat (REST parity with IPC sendMessage; #4279)
 * - `POST /api/send-card` — Send a Feishu card to a chat (REST parity with IPC sendCard; #4279)
 *
 * Authentication:
 * - When `apiToken` is configured, non-GET routes require `Authorization: Bearer <token>`
 * - GET routes remain unauthenticated for health checks
 *
 * @module primary-node/http-api-server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger, type TopicGroupMessageEvent, type FeishuCard } from '@disclaude/core';
import { PRIMARY_NODE_VERSION } from './version.js';
// Issue #4063: reuse the canonical loop types instead of re-declaring them inline.
import type { LoopStartParams, LoopStatus } from './loop/loop-runner.js';

const logger = createLogger('HttpApiServer');

/**
 * Configuration for the HTTP API server.
 */
export interface HttpApiServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** API token for Bearer authentication on write routes */
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
 * Response payload for sendMessage (mirrors IPC IpcResponsePayloads).
 */
export type SendMessageResponse = { success: boolean; messageId?: string };

/**
 * Handler for sendMessage requests. Delegates to the channel's sendMessage
 * capability — REST parity with the IPC method (Issue #4279).
 */
export type SendMessageHandler = (
  chatId: string,
  text: string,
  threadId: string | undefined,
  mentions: Array<{ openId: string; name?: string }> | undefined,
) => Promise<SendMessageResponse>;

/**
 * Handler for sendCard requests. Delegates to the channel's sendCard
 * capability — REST parity with the IPC method (Issue #4279).
 */
export type SendCardHandler = (
  chatId: string,
  card: FeishuCard,
  threadId: string | undefined,
  description: string | undefined,
) => Promise<{ success: boolean; messageId?: string }>;

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
  private sendMessageHandler?: SendMessageHandler;
  private sendCardHandler?: SendCardHandler;
  private loopStartHandler?: (params: LoopStartParams) => { loopId: string };
  private loopStopHandler?: (loopId: string) => void;
  private loopStatusHandler?: (loopId: string) => LoopStatus | null;
  /** Connected SSE clients for topic notifications (Issue #4031) */
  private readonly sseClients = new Set<ServerResponse>();
  /** Heartbeat interval timer for SSE keepalive */
  private sseHeartbeat: ReturnType<typeof setInterval> | null = null;

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
   * Set the handler for POST /api/send-message (Issue #4279).
   */
  setSendMessageHandler(handler: SendMessageHandler): void {
    this.sendMessageHandler = handler;
  }

  /**
   * Set the handler for POST /api/send-card (Issue #4279).
   */
  setSendCardHandler(handler: SendCardHandler): void {
    this.sendCardHandler = handler;
  }

  setLoopHandlers(handlers: {
    start: (params: LoopStartParams) => { loopId: string };
    stop: (loopId: string) => void;
    status: (loopId: string) => LoopStatus | null;
  }): void {
    this.loopStartHandler = handlers.start;
    this.loopStopHandler = handlers.stop;
    this.loopStatusHandler = handlers.status;
  }

  /**
   * Broadcast a topic group message event to all connected SSE clients.
   *
   * Issue #4031: Local apps connect via GET /api/topic-stream to receive
   * real-time topic group message notifications.
   *
   * @param event - The topic group message event to broadcast
   */
  broadcastTopicEvent(event: TopicGroupMessageEvent): void {
    if (this.sseClients.size === 0) {
      return;
    }

    const data = JSON.stringify(event);
    const deadClients: ServerResponse[] = [];

    for (const client of this.sseClients) {
      if (client.writableEnded) {
        deadClients.push(client);
        continue;
      }
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
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
  private startSseHeartbeat(): void {
    if (this.sseHeartbeat) {
      return;
    }
    this.sseHeartbeat = setInterval(() => {
      if (this.sseClients.size === 0) {
        return;
      }
      const deadClients: ServerResponse[] = [];
      for (const client of this.sseClients) {
        if (client.writableEnded) {
          deadClients.push(client);
          continue;
        }
        try {
          client.write(': ping\n\n');
        } catch {
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
  private stopSseHeartbeat(): void {
    if (this.sseHeartbeat) {
      clearInterval(this.sseHeartbeat);
      this.sseHeartbeat = null;
    }
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

    // Close all SSE connections (Issue #4031)
    this.stopSseHeartbeat();
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* best effort */ }
    }
    this.sseClients.clear();

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
    // Issue #4168 (Phase 1, #4279): REST parity with the IPC `ping` method —
    // a token-exempt (GET) health-check endpoint.
    this.addRoute('GET', '/api/ping', this.handlePing.bind(this));
    // Issue #4279: REST parity with IPC sendMessage.
    this.addRoute('POST', '/api/send-message', this.handleSendMessage.bind(this));
    // Issue #4279: REST parity with IPC sendCard.
    this.addRoute('POST', '/api/send-card', this.handleSendCard.bind(this));
    this.addRoute('POST', '/api/push', this.handlePush.bind(this));
    // Issue #4031: SSE endpoint for topic group message notifications
    this.addRoute('GET', '/api/topic-stream', this.handleTopicStream.bind(this));
    // Issue #4075: Loop Runner REST endpoints
    this.addRoute('POST', '/api/loop/start', this.handleLoopStart.bind(this));
    this.addRoute('POST', '/api/loop/stop', this.handleLoopStop.bind(this));
    this.addRoute('GET', '/api/loop/status/:loopId', this.handleLoopStatus.bind(this));
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
        const expected = `Bearer ${this.config.apiToken}`;
        const authBuf = Buffer.from(authHeader ?? '');
        const expectedBuf = Buffer.from(expected);
        if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
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
   * GET /api/ping handler.
   *
   * Issue #4168 (Phase 1, #4279): REST health-check endpoint. The response
   * payload mirrors the IPC `ping` method's payload (`{ pong: true }`); the IPC
   * envelope (`{ success: true, payload: ... }`) is dropped because HTTP 200
   * already signals success. GET routes are token-exempt (see the apiToken
   * check), so it works like /api/status for liveness probes.
   */
  private handlePing(
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
  ): Promise<void> {
    this.sendJson(res, 200, { pong: true });
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
   * POST /api/send-message handler (Issue #4279).
   *
   * Accepts `{ chatId, text, threadId?, mentions? }` and delegates to the
   * channel's sendMessage capability. Mirrors the IPC sendMessage method
   * (payload aligned with IpcRequestPayloads). Response: `{ success, messageId? }`.
   */
  private async handleSendMessage(
    req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
  ): Promise<void> {
    if (!this.sendMessageHandler) {
      this.sendJson(res, 503, { ok: false, message: 'sendMessage handler not configured' });
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
      typeof (parsed as Record<string, unknown>).text !== 'string'
    ) {
      this.sendJson(res, 400, { ok: false, message: 'Required fields: chatId (string), text (string)' });
      return;
    }

    const raw = parsed as Record<string, unknown>;

    // Reject empty chatId/text early — symmetric with handlePush. Without this,
    // the channel would return a messy 500 on empty input instead of a clean 400.
    if (!raw.chatId || !raw.text) {
      this.sendJson(res, 400, { ok: false, message: 'chatId and text must be non-empty' });
      return;
    }

    const threadId = typeof raw.threadId === 'string' ? raw.threadId : undefined;

    // Validate mentions element shape (each must be { openId: string }). REST is
    // the trust boundary, so harden here even though the IPC path casts unchecked.
    const mentions = normalizeMentions(raw.mentions);
    if (mentions === null) {
      this.sendJson(res, 400, { ok: false, message: 'mentions must be an array of { openId: string; name?: string }' });
      return;
    }

    try {
      const result = await this.sendMessageHandler(raw.chatId as string, raw.text as string, threadId, mentions);
      this.sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      logger.error({ err, chatId: raw.chatId }, 'sendMessage handler error');
      const msg = err instanceof Error ? err.message : 'sendMessage failed';
      this.sendJson(res, 500, { ok: false, message: msg });
    }
  }

  /**
   * POST /api/send-card handler (Issue #4279).
   *
   * Accepts `{ chatId, card, threadId?, description? }` and delegates to the
   * channel's sendCard capability. Mirrors the IPC sendCard method (payload
   * aligned with IpcRequestPayloads). `card` is a Feishu card JSON object.
   * Response: `{ ok: true, success: true }`.
   */
  private async handleSendCard(
    req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
  ): Promise<void> {
    if (!this.sendCardHandler) {
      this.sendJson(res, 503, { ok: false, message: 'sendCard handler not configured' });
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
      typeof (parsed as Record<string, unknown>).card !== 'object' || (parsed as Record<string, unknown>).card === null
    ) {
      this.sendJson(res, 400, { ok: false, message: 'Required fields: chatId (string), card (object)' });
      return;
    }

    const raw = parsed as Record<string, unknown>;
    const threadId = typeof raw.threadId === 'string' ? raw.threadId : undefined;
    const description = typeof raw.description === 'string' ? raw.description : undefined;

    try {
      const result = await this.sendCardHandler(
        raw.chatId as string,
        raw.card as FeishuCard,
        threadId,
        description,
      );
      this.sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      logger.error({ err, chatId: raw.chatId }, 'sendCard handler error');
      const msg = err instanceof Error ? err.message : 'sendCard failed';
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
  private handleTopicStream(
    _req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>,
  ): Promise<void> {
    // SSE requires HTTP/1.1 — set appropriate headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
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

  // Issue #4075: Loop Runner REST endpoints

  private async handleLoopStart(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
    if (!this.loopStartHandler) { this.sendJson(res, 503, { ok: false, message: 'Loop handler not configured' }); return; }
    let body: string;
    try { body = await readBody(req); } catch { this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' }); return; }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).chatId !== 'string' || typeof (parsed as Record<string, unknown>).prompt !== 'string') {
      this.sendJson(res, 400, { ok: false, message: 'Required fields: chatId (string), prompt (string)' }); return;
    }
    const p = parsed as { chatId: string; prompt: string; maxSteps?: number; maxDurationMs?: number; stepIntervalMs?: number };
    if (!p.chatId || !p.prompt) { this.sendJson(res, 400, { ok: false, message: 'chatId and prompt must be non-empty' }); return; }
    if (p.maxSteps !== undefined && typeof p.maxSteps !== 'number') { this.sendJson(res, 400, { ok: false, message: 'maxSteps must be a number' }); return; }
    if (p.maxDurationMs !== undefined && typeof p.maxDurationMs !== 'number') { this.sendJson(res, 400, { ok: false, message: 'maxDurationMs must be a number' }); return; }
    if (p.stepIntervalMs !== undefined && typeof p.stepIntervalMs !== 'number') { this.sendJson(res, 400, { ok: false, message: 'stepIntervalMs must be a number' }); return; }
    try {
      const result = this.loopStartHandler({ chatId: p.chatId, prompt: p.prompt, ...(p.maxSteps !== undefined && { maxSteps: p.maxSteps }), ...(p.maxDurationMs !== undefined && { maxDurationMs: p.maxDurationMs }), ...(p.stepIntervalMs !== undefined && { stepIntervalMs: p.stepIntervalMs }) });
      this.sendJson(res, 200, { ok: true, loopId: result.loopId });
    } catch (err) { this.sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : 'Loop start failed' }); }
  }

  private async handleLoopStop(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
    if (!this.loopStopHandler) { this.sendJson(res, 503, { ok: false, message: 'Loop handler not configured' }); return; }
    let body: string;
    try { body = await readBody(req); } catch { this.sendJson(res, 413, { ok: false, message: 'Request body too large (max 1 MB)' }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { ok: false, message: 'Invalid JSON body' }); return; }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).loopId !== 'string') { this.sendJson(res, 400, { ok: false, message: 'Required field: loopId (string)' }); return; }
    const { loopId } = parsed as { loopId: string };
    if (!loopId) { this.sendJson(res, 400, { ok: false, message: 'loopId must be non-empty' }); return; }
    this.loopStopHandler(loopId);
    this.sendJson(res, 200, { ok: true, message: `Loop stopped: ${loopId}` });
  }

  private handleLoopStatus(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (!this.loopStatusHandler) { this.sendJson(res, 503, { ok: false, message: 'Loop handler not configured' }); return Promise.resolve(); }
    const { loopId } = params;
    if (!loopId) { this.sendJson(res, 400, { ok: false, message: 'loopId parameter is required' }); return Promise.resolve(); }
    const status = this.loopStatusHandler(loopId);
    if (!status) { this.sendJson(res, 404, { ok: false, message: `Loop not found: ${loopId}` }); }
    else { this.sendJson(res, 200, { ok: true, status }); }
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

/**
 * Normalize the optional `mentions` field of POST /api/send-message.
 *
 * Returns:
 * - `undefined` when the field is absent (no mentions).
 * - the typed array when every element is `{ openId: string; name?: string }`.
 * - `null` when the field is present but malformed (caller responds 400).
 *
 * REST is the trust boundary, so this validates element shape even though the
 * IPC path casts `mentions` unchecked (Issue #4279).
 */
function normalizeMentions(
  raw: unknown,
): Array<{ openId: string; name?: string }> | undefined | null {
  if (raw === undefined) { return undefined; }
  if (!Array.isArray(raw)) { return null; }
  for (const m of raw) {
    if (
      typeof m !== 'object' || m === null ||
      typeof (m as Record<string, unknown>).openId !== 'string'
    ) {
      return null;
    }
  }
  return raw as Array<{ openId: string; name?: string }>;
}
