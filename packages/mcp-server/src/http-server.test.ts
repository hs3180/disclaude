/**
 * Tests for Streamable HTTP MCP Server (http-server.ts)
 *
 * Covers:
 * - Constructor with default and custom config
 * - Start/stop lifecycle
 * - HTTP request routing (POST /mcp, GET /mcp, DELETE /mcp, 404)
 * - MCP message handling (JSON parsing, notifications, parse errors)
 * - Request error handling
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

// Mock handleJsonRpc so we can control responses
vi.mock('./mcp-jsonrpc.js', () => ({
  handleJsonRpc: vi.fn((_req: any, sendResponse: (r: unknown) => void) => {
    sendResponse({ jsonrpc: '2.0', id: _req.id ?? 1, result: {} });
    return Promise.resolve();
  }),
}));

import { HttpMcpServer } from './http-server.js';
import { handleJsonRpc } from './mcp-jsonrpc.js';
import http from 'node:http';

const mockHandleJsonRpc = vi.mocked(handleJsonRpc);

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: make an HTTP request to a running HttpMcpServer.
 */
function httpRequest(
  url: string,
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) { req.write(body); }
    req.end();
  });
}

// ============================================================================
// Constructor
// ============================================================================
describe('HttpMcpServer', () => {
  describe('constructor', () => {
    it('should accept default empty config', () => {
      const server = new HttpMcpServer();
      expect(server).toBeDefined();
    });

    it('should accept custom config', () => {
      const server = new HttpMcpServer({ port: 9090, host: '0.0.0.0' });
      expect(server).toBeDefined();
    });
  });

  describe('lifecycle', () => {
    it('should start and return url and port', async () => {
      const server = new HttpMcpServer();
      const addr = await server.start();
      expect(addr.url).toContain('http://localhost:');
      expect(addr.url).toContain('/mcp');
      expect(addr.port).toBeGreaterThan(0);
      await server.stop();
    });

    it('should start on specified port when given', async () => {
      const server = new HttpMcpServer({ port: 0 });
      const addr = await server.start();
      expect(addr.port).toBeGreaterThan(0);
      await server.stop();
    });

    it('should stop gracefully', async () => {
      const server = new HttpMcpServer();
      await server.start();
      await server.stop();
      // Should not throw
    });

    it('should handle stop when not started', async () => {
      const server = new HttpMcpServer();
      await server.stop();
      // Should not throw
    });

    it('should bind to custom host', async () => {
      const server = new HttpMcpServer({ host: '127.0.0.1' });
      const addr = await server.start();
      expect(addr.url).toContain('127.0.0.1');
      await server.stop();
    });
  });

  describe('request routing', () => {
    let server: HttpMcpServer;
    let baseUrl: string;

    beforeEach(async () => {
      server = new HttpMcpServer();
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

    it('should return 405 for GET /mcp', async () => {
      const result = await httpRequest(`${baseUrl}/mcp`, { method: 'GET' });
      expect(result.statusCode).toBe(405);
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe(-32000);
    });

    it('should return 204 for DELETE /mcp', async () => {
      const result = await httpRequest(`${baseUrl}/mcp`, { method: 'DELETE' });
      expect(result.statusCode).toBe(204);
    });

    it('should handle POST /mcp with valid JSON-RPC', async () => {
      const rpcRequest = { jsonrpc: '2.0', id: 1, method: 'initialize' };
      const result = await httpRequest(
        `${baseUrl}/mcp`,
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
        `${baseUrl}/mcp`,
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
        `${baseUrl}/mcp`,
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
        `${baseUrl}/mcp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify(notification),
      );
      expect(result.statusCode).toBe(204);
    });
  });

  describe('POST /mcp response forwarding', () => {
    let server: HttpMcpServer;
    let baseUrl: string;

    beforeEach(async () => {
      server = new HttpMcpServer();
      const addr = await server.start();
      baseUrl = `http://localhost:${addr.port}`;
    });

    afterEach(async () => {
      await server.stop();
    });

    it('should forward handleJsonRpc response to client', async () => {
      mockHandleJsonRpc.mockImplementation((_req, sendResponse) => {
        sendResponse({ jsonrpc: '2.0', id: 42, result: { custom: 'data' } });
      });

      const result = await httpRequest(
        `${baseUrl}/mcp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }),
      );

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.id).toBe(42);
      expect(body.result.custom).toBe('data');
    });
  });
});
