/**
 * Tests for SSE MCP Server (sse-server.ts)
 *
 * Covers:
 * - Constructor with default and custom config
 * - Start/stop lifecycle
 * - HTTP request routing (GET /sse, POST /messages, 404)
 * - SSE connection handling (endpoint event, client tracking)
 * - Message handling (JSON parsing, notifications, parse errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('./mcp-jsonrpc.js', () => ({
  handleJsonRpc: vi.fn((_req: any, sendResponse: (r: unknown) => void) => {
    sendResponse({ jsonrpc: '2.0', id: _req.id ?? 1, result: {} });
    return Promise.resolve();
  }),
}));

import { SseMcpServer } from './sse-server.js';
import { handleJsonRpc } from './mcp-jsonrpc.js';
import http from 'node:http';

const mockHandleJsonRpc = vi.mocked(handleJsonRpc);

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: make an HTTP request.
 */
function httpRequest(
  url: string,
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) { req.write(body); }
    req.end();
  });
}

/**
 * Helper: make an SSE request that collects initial data then aborts.
 * SSE connections are long-lived so we read the initial data and destroy.
 */
function sseRequest(
  url: string,
): Promise<{ statusCode: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        // After receiving initial data, destroy the connection
        if (data.includes('event: endpoint')) {
          res.destroy();
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', (err) => {
      // Connection reset is expected when we destroy
      if ((err as any).code === 'ECONNRESET') {
        resolve({ statusCode: undefined, headers: {}, body: '' });
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// ============================================================================
// Constructor
// ============================================================================
describe('SseMcpServer', () => {
  describe('constructor', () => {
    it('should accept default empty config', () => {
      const server = new SseMcpServer();
      expect(server).toBeDefined();
    });

    it('should accept custom config', () => {
      const server = new SseMcpServer({ port: 9091, host: '0.0.0.0' });
      expect(server).toBeDefined();
    });
  });

  describe('lifecycle', () => {
    it('should start and return url and port', async () => {
      const server = new SseMcpServer();
      const addr = await server.start();
      expect(addr.url).toContain('http://localhost:');
      expect(addr.url).toContain('/sse');
      expect(addr.port).toBeGreaterThan(0);
      await server.stop();
    });

    it('should start on specified port when given', async () => {
      const server = new SseMcpServer({ port: 0 });
      const addr = await server.start();
      expect(addr.port).toBeGreaterThan(0);
      await server.stop();
    });

    it('should stop gracefully', async () => {
      const server = new SseMcpServer();
      await server.start();
      await server.stop();
    });

    it('should handle stop when not started', async () => {
      const server = new SseMcpServer();
      await server.stop();
      // Should not throw
    });

    it('should bind to custom host', async () => {
      const server = new SseMcpServer({ host: '127.0.0.1' });
      const addr = await server.start();
      expect(addr.url).toContain('127.0.0.1');
      await server.stop();
    });
  });

  describe('request routing', () => {
    let server: SseMcpServer;
    let baseUrl: string;

    beforeEach(async () => {
      server = new SseMcpServer();
      const addr = await server.start();
      baseUrl = `http://localhost:${addr.port}`;
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should return 404 for unknown paths', async () => {
      const result = await httpRequest(`${baseUrl}/unknown`, { method: 'GET' });
      expect(result.statusCode).toBe(404);
    });
  });

  describe('SSE connection', () => {
    let server: SseMcpServer;
    let baseUrl: string;
    let port: number;

    beforeEach(async () => {
      server = new SseMcpServer();
      const addr = await server.start();
      baseUrl = `http://localhost:${addr.port}`;
      ({ port } = addr);
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should accept GET /sse and return text/event-stream', async () => {
      const result = await sseRequest(`${baseUrl}/sse`);
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toContain('text/event-stream');
      expect(result.headers['cache-control']).toContain('no-cache');
    });

    it('should send endpoint event with message URL', async () => {
      const result = await sseRequest(`${baseUrl}/sse`);
      expect(result.body).toContain('event: endpoint');
      expect(result.body).toContain(`http://localhost:${port}/messages`);
    });
  });

  describe('POST /messages', () => {
    let server: SseMcpServer;
    let baseUrl: string;

    beforeEach(async () => {
      server = new SseMcpServer();
      const addr = await server.start();
      baseUrl = `http://localhost:${addr.port}`;
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should handle valid JSON-RPC message', async () => {
      const rpcRequest = { jsonrpc: '2.0', id: 1, method: 'initialize' };
      const result = await httpRequest(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify(rpcRequest),
      );
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(mockHandleJsonRpc).toHaveBeenCalledTimes(1);
    });

    it('should return parse error for invalid JSON', async () => {
      const result = await httpRequest(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        'not json{{{',
      );
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe(-32700);
      expect(body.error.message).toContain('Parse error');
    });

    it('should return 204 for notifications (no id)', async () => {
      const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
      const result = await httpRequest(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify(notification),
      );
      expect(result.statusCode).toBe(204);
    });

    it('should return 204 for notification with null id', async () => {
      const notification = { jsonrpc: '2.0', id: null, method: 'notifications/initialized' };
      const result = await httpRequest(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify(notification),
      );
      expect(result.statusCode).toBe(204);
    });

    it('should forward handleJsonRpc response to client', async () => {
      mockHandleJsonRpc.mockImplementation((_req, sendResponse) => {
        sendResponse({ jsonrpc: '2.0', id: 99, result: { data: 'custom' } });
      });

      const result = await httpRequest(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
      );

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.id).toBe(99);
      expect(body.result.data).toBe('custom');
    });
  });

  describe('stop with active SSE clients', () => {
    it('should close all SSE client connections on stop', async () => {
      const server = new SseMcpServer();
      const addr = await server.start();
      const baseUrl = `http://localhost:${addr.port}`;

      // Open an SSE connection
      const sseResult = await sseRequest(`${baseUrl}/sse`);
      expect(sseResult.statusCode).toBe(200);

      // Stopping server should close the SSE client gracefully
      await server.stop();
    });
  });
});
