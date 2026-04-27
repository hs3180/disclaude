/**
 * SSE MCP Server - HTTP Server-Sent Events transport for channel-mcp.
 *
 * @deprecated Use HttpMcpServer (Streamable HTTP) instead.
 * SSE transport is legacy; Streamable HTTP is the modern MCP standard.
 *
 * @module mcp-server/sse-server
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createLogger } from '@disclaude/core';
import { handleJsonRpc } from './mcp-jsonrpc.js';

const logger = createLogger('SseMcpServer');

// ============================================================================
// SSE MCP Server
// ============================================================================

/**
 * SSE MCP Server configuration.
 */
export interface SseMcpServerConfig {
  /** Port to listen on (0 = auto-select) */
  port?: number;
  /** Host to bind to */
  host?: string;
}

/**
 * SSE MCP Server - HTTP server implementing MCP SSE transport.
 *
 * @deprecated Use {@link import('./http-server.js').HttpMcpServer} instead.
 */
export class SseMcpServer {
  private config: SseMcpServerConfig;
  private httpServer: Server | null = null;
  private sseClients = new Set<ServerResponse>();

  constructor(config: SseMcpServerConfig = {}) {
    this.config = config;
  }

  /**
   * Start the HTTP server.
   * @returns The SSE URL for clients to connect to
   */
  async start(): Promise<{ url: string; port: number }> {
    const host = this.config.host ?? 'localhost';
    const port = this.config.port ?? 0;

    const addr = await new Promise<{ url: string; port: number }>((resolve, reject) => {
      this.httpServer = createServer((req, res) => this.handleRequest(req, res));

      this.httpServer.on('error', reject);

      this.httpServer.listen(port, host, () => {
        const address = this.httpServer?.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        const url = `http://${host}:${actualPort}/sse`;

        logger.info({ url, port: actualPort }, 'SSE MCP server started');
        resolve({ url, port: actualPort });
      });
    });

    return addr;
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (!this.httpServer) {
      return;
    }

    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    await new Promise<void>((resolve) => {
      const server = this.httpServer;
      server?.close(() => {
        logger.info('SSE MCP server stopped');
        this.httpServer = null;
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP request.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      this.handleSseConnection(req, res);
    } else if (req.method === 'POST' && url.pathname === '/messages') {
      this.handleMessage(req, res);
    } else {
      res.writeHead(404).end('Not Found');
    }
  }

  /**
   * Handle SSE connection (GET /sse).
   */
  private handleSseConnection(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const addr = this.httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const host = this.config.host ?? 'localhost';
    const endpointUrl = `http://${host}:${port}/messages`;

    res.write(`event: endpoint\ndata: ${JSON.stringify(endpointUrl)}\n\n`);

    this.sseClients.add(res);

    res.on('close', () => {
      this.sseClients.delete(res);
      logger.debug('SSE client disconnected');
    });

    logger.debug('SSE client connected');
  }

  /**
   * Handle JSON-RPC message (POST /messages).
   */
  private handleMessage(req: IncomingMessage, res: ServerResponse): void {
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const request = JSON.parse(body);

        const sendResponse = (response: unknown) => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        };

        // Notifications (no id) — acknowledge but don't send JSON-RPC response
        if (request.id === undefined || request.id === null) {
          await handleJsonRpc(request, () => {});
          if (!res.writableEnded) {
            res.writeHead(204).end();
          }
          return;
        }

        await handleJsonRpc(request, sendResponse);
      } catch (error) {
        logger.error({ err: error }, 'Failed to handle message');
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }));
        }
      }
    });

    req.on('error', (error) => {
      logger.error({ err: error }, 'Request error');
      if (!res.writableEnded) {
        res.writeHead(500).end('Internal Server Error');
      }
    });
  }
}
