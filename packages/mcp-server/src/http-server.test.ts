/**
 * Tests for HTTP MCP Server (Streamable HTTP transport).
 *
 * Covers server lifecycle (start/stop), request routing,
 * JSON-RPC message handling, and error scenarios.
 *
 * Uses node:http directly instead of global fetch() to avoid
 * nock's FetchInterceptor compatibility issues on Node.js 20
 * (nock 14.x patches globalThis.fetch via msw, which may return
 * undefined on Node 20).
 *
 * @module mcp-server/http-server
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request, type IncomingMessage } from 'node:http';
import { URL } from 'node:url';

// Mock tool implementations
vi.mock('./index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive_message: vi.fn(),
  send_file: vi.fn(),
}));

vi.mock('./utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn().mockReturnValue(true),
  getCardValidationError: vi.fn().mockReturnValue('invalid card'),
}));

import { HttpMcpServer } from './http-server.js';
import { send_text } from './index.js';

const mocked_send_text = vi.mocked(send_text);

beforeEach(() => {
  vi.clearAllMocks();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTTP request helper (bypasses nock's fetch interceptor)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface TestResponse {
  status: number;
  json(): Promise<Record<string, unknown>>;
  text(): Promise<string>;
}

/**
 * Make an HTTP request using node:http (bypasses nock fetch interception).
 *
 * Provides a fetch-like interface: `{ status, json(), text() }`.
 */
function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  const parsed = new URL(url);
  const {body} = options;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: options.method ?? 'GET',
        headers: options.headers ?? (body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(raw) as Record<string, unknown>),
            text: () => Promise.resolve(raw),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

// ============================================================================
// Server lifecycle
// ============================================================================
describe('HttpMcpServer lifecycle', () => {
  it('should start and return a URL with port', async () => {
    const server = new HttpMcpServer({ port: 0 });
    const { url, port } = await server.start();

    expect(url).toContain('http://localhost:');
    expect(url).toContain('/mcp');
    expect(port).toBeGreaterThan(0);

    await server.stop();
  });

  it('should start on specified host', async () => {
    const server = new HttpMcpServer({ host: '127.0.0.1', port: 0 });
    const { url } = await server.start();

    expect(url).toContain('127.0.0.1');

    await server.stop();
  });

  it('should stop gracefully when already stopped', async () => {
    const server = new HttpMcpServer();
    // Should not throw
    await server.stop();
  });

  it('should stop and release port', async () => {
    const server = new HttpMcpServer({ port: 0 });
    const { port: _port } = await server.start();

    await server.stop();

    // After stopping, the server should be null
    // Verify we can create a new server on the same port
    const server2 = new HttpMcpServer({ port: 0 });
    await server2.start();
    await server2.stop();
  });
});

// ============================================================================
// Request routing
// ============================================================================
describe('HttpMcpServer request routing', () => {
  let server: HttpMcpServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new HttpMcpServer({ port: 0 });
    const { url } = await server.start();
    baseUrl = url;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should return 404 for unknown paths', async () => {
    const response = await httpRequest(baseUrl.replace('/mcp', '/unknown'));
    expect(response.status).toBe(404);
  });

  it('should return 405 for GET /mcp', async () => {
    const response = await httpRequest(baseUrl, { method: 'GET' });
    expect(response.status).toBe(405);
  });

  it('should return 204 for DELETE /mcp', async () => {
    const response = await httpRequest(baseUrl, { method: 'DELETE' });
    expect(response.status).toBe(204);
  });
});

// ============================================================================
// JSON-RPC message handling
// ============================================================================
describe('HttpMcpServer JSON-RPC handling', () => {
  let server: HttpMcpServer;
  let mcpUrl: string;

  beforeEach(async () => {
    server = new HttpMcpServer({ port: 0 });
    const { url } = await server.start();
    mcpUrl = url;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should handle initialize request', async () => {
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(1);
    const result = data.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
  });

  it('should handle tools/list request', async () => {
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    const result = data.result as Record<string, unknown>;
    expect(result.tools).toBeInstanceOf(Array);
    expect((result.tools as unknown[]).length).toBeGreaterThan(0);
  });

  it('should handle ping request', async () => {
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'ping',
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.result).toEqual({});
  });

  it('should handle tools/call request', async () => {
    mocked_send_text.mockResolvedValue({
      success: true,
      message: 'sent',
    });
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'send_text',
          arguments: { text: 'hello', chatId: 'oc_test' },
        },
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    const result = data.result as Record<string, unknown>;
    expect(result).toBeDefined();
    expect(result.content).toBeInstanceOf(Array);
  });

  it('should return error for unknown method', async () => {
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'nonexistent',
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    const error = data.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
  });

  it('should handle notification (no id) with 204', async () => {
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    expect(response.status).toBe(204);
  });

  it('should return parse error for invalid JSON', async () => {
    const response = await httpRequest(mcpUrl, {
      method: 'POST',
      body: 'not valid json{{{',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    const error = data.error as Record<string, unknown>;
    expect(error.code).toBe(-32700);
    expect(error.message).toContain('Parse error');
  });
});
