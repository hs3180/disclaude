/**
 * Streamable HTTP MCP Server - MCP over HTTP POST transport.
 *
 * Implements the MCP Streamable HTTP protocol:
 * - POST /mcp — Client sends JSON-RPC requests, server responds inline
 *
 * This is the modern MCP transport, replacing the legacy SSE transport.
 * Clients declare HTTP support via `"mcpCapabilities":{"http":true}`.
 *
 * @module mcp-server/http-server
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createLogger } from '@disclaude/core';
import { handleJsonRpc } from './mcp-jsonrpc.js';

const logger = createLogger('HttpMcpServer');

// ============================================================================
// Streamable HTTP MCP Server
// ============================================================================

/**
 * HTTP MCP Server configuration.
 */
export interface HttpMcpServerConfig {
  /** Port to listen on (0 = auto-select) */
  port?: number;
  /** Host to bind to */
  host?: string;
}

/**
 * Streamable HTTP MCP Server.
 *
 * Implements MCP over HTTP POST (Streamable HTTP transport).
 * All JSON-RPC communication goes through a single POST /mcp endpoint.
 *
 * @example
 * ```typescript
 * const server = new HttpMcpServer({ port: 0 });
 * const { url } = await server.start();
 * console.log(`HTTP_URL=${url}`);
 * ```
 */
export class HttpMcpServer {
  private config: HttpMcpServerConfig;
  private httpServer: Server | null = null;

  constructor(config: HttpMcpServerConfig = {}) {
    this.config = config;
  }

  /**
   * Start the HTTP server.
   * @returns The MCP endpoint URL for clients to POST to
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
        const url = `http://${host}:${actualPort}/mcp`;

        logger.info({ url, port: actualPort }, 'HTTP MCP server started');
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

    await new Promise<void>((resolve) => {
      const server = this.httpServer;
      server?.close(() => {
        logger.info('HTTP MCP server stopped');
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

    // Streamable HTTP: all requests go to POST /mcp
    if (req.method === 'POST' && url.pathname === '/mcp') {
      this.handleMcpMessage(req, res);
    } else if (req.method === 'GET' && url.pathname === '/mcp') {
      // SSE streaming for server-initiated messages (optional, not used in basic mode)
      // Respond with 405 to indicate POST is required
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' } }));
    } else if (req.method === 'DELETE' && url.pathname === '/mcp') {
      // Session termination (optional)
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end('Not Found');
    }
  }

  /**
   * Handle MCP JSON-RPC message (POST /mcp).
   */
  private handleMcpMessage(req: IncomingMessage, res: ServerResponse): void {
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
        logger.error({ err: error }, 'Failed to handle MCP message');
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
