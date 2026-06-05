/**
 * Tests for HttpApiServer.
 *
 * Issue #3857 Phase 2: HTTP API server for Primary Node.
 *
 * NOTE: Uses node:http instead of global fetch to avoid nock/undici
 * incompatibility in CI (Node.js 20). The test setup (tests/setup.ts)
 * uses nock.disableNetConnect() which patches http/https modules but
 * interferes with fetch (backed by undici in Node.js 20), causing
 * fetch() to return undefined.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { HttpApiServer, type StatusResponse, type PushResponse } from './http-api-server.js';

/**
 * Make an HTTP request using node:http (nock-compatible).
 * Returns { statusCode, headers, body }.
 */
function httpRequest(
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function httpGet(url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
  });
}

describe('HttpApiServer', () => {
  const port = 19200; // Use non-standard port for tests
  let server: HttpApiServer;

  beforeAll(async () => {
    server = new HttpApiServer({ port, host: 'localhost' });
    server.setNodeId('test-node-1');
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('GET /api/status', () => {
    it('should return status ok', async () => {
      const { statusCode, body } = await httpGet(`http://localhost:${port}/api/status`);
      expect(statusCode).toBe(200);

      const data = JSON.parse(body) as StatusResponse;
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
      expect(data.nodeId).toBe('test-node-1');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.version).toBeDefined();
    });

    it('should return JSON content type', async () => {
      const { headers } = await httpGet(`http://localhost:${port}/api/status`);
      expect(headers['content-type']).toContain('application/json');
    });

    it('should increase uptime over time', async () => {
      const { body: body1 } = await httpGet(`http://localhost:${port}/api/status`);
      const data1 = JSON.parse(body1) as StatusResponse;

      await new Promise((resolve) => setTimeout(resolve, 100));

      const { body: body2 } = await httpGet(`http://localhost:${port}/api/status`);
      const data2 = JSON.parse(body2) as StatusResponse;

      expect(data2.uptime).toBeGreaterThanOrEqual(data1.uptime);
    });
  });

  describe('unknown routes', () => {
    it('should return 404 for unknown paths', async () => {
      const { statusCode, body } = await httpGet(`http://localhost:${port}/unknown`);
      expect(statusCode).toBe(404);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toBe('Not found');
    });

    it('should return 404 for unknown API paths', async () => {
      const { statusCode } = await httpGet(`http://localhost:${port}/api/unknown`);
      expect(statusCode).toBe(404);
    });
  });

  describe('HTTP method matching', () => {
    it('should return 404 for POST to GET-only route', async () => {
      const { statusCode } = await httpRequest({
        hostname: 'localhost',
        port,
        path: '/api/status',
        method: 'POST',
      });
      expect(statusCode).toBe(404);
    });
  });

  describe('lifecycle', () => {
    it('should report running after start', () => {
      expect(server.isRunning).toBe(true);
    });

    it('should handle stop when already stopped', async () => {
      const stoppedServer = new HttpApiServer({ port: 19201, host: 'localhost' });
      stoppedServer.setNodeId('test-stopped');
      // Not started — stop should be a no-op
      await stoppedServer.stop();
      expect(stoppedServer.isRunning).toBe(false);
    });

    it('should handle start when already running', async () => {
      // server is already started in beforeAll — calling start again should be a no-op
      await server.start();
      expect(server.isRunning).toBe(true);
    });

    it('should report not running after stop', async () => {
      const tempServer = new HttpApiServer({ port: 19202, host: 'localhost' });
      tempServer.setNodeId('test-temp');
      await tempServer.start();
      expect(tempServer.isRunning).toBe(true);

      await tempServer.stop();
      expect(tempServer.isRunning).toBe(false);
    });
  });

  describe('POST /api/push', () => {
    it('should return 503 when push handler is not configured', async () => {
      // Create a separate server without push handler
      const noPushServer = new HttpApiServer({ port: 19203, host: 'localhost' });
      await noPushServer.start();

      const { statusCode, body } = await httpRequest({
        hostname: 'localhost',
        port: 19203,
        path: '/api/push',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ chatId: 'oc_test', message: 'hello' }));

      await noPushServer.stop();

      expect(statusCode).toBe(503);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('not configured');
    });

    it('should accept push and call handler', async () => {
      const mockHandler = vi.fn().mockResolvedValue(undefined);
      server.setPushHandler(mockHandler);

      const { statusCode, body } = await httpRequest({
        hostname: 'localhost',
        port,
        path: '/api/push',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ chatId: 'oc_test', message: 'hello world' }));

      expect(statusCode).toBe(200);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(true);
      expect(data.message).toBe('Push accepted');
      expect(mockHandler).toHaveBeenCalledWith('oc_test', 'hello world');
    });

    it('should return 400 for invalid JSON', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await httpRequest({
        hostname: 'localhost',
        port,
        path: '/api/push',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, 'not json');

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Invalid JSON');
    });

    it('should return 400 for missing chatId', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await httpRequest({
        hostname: 'localhost',
        port,
        path: '/api/push',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ message: 'hello' }));

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Required fields');
    });

    it('should return 400 for missing message', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await httpRequest({
        hostname: 'localhost',
        port,
        path: '/api/push',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ chatId: 'oc_test' }));

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Required fields');
    });

    it('should return 500 when handler throws', async () => {
      server.setPushHandler(() => Promise.reject(new Error('Agent not found')));

      const { statusCode, body } = await httpRequest({
        hostname: 'localhost',
        port,
        path: '/api/push',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ chatId: 'oc_test', message: 'hello' }));

      expect(statusCode).toBe(500);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Agent not found');
    });
  });
});
