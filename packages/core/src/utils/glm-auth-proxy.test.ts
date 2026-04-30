/**
 * Tests for GLM Auth Proxy (Issue #2916).
 *
 * Verifies that the proxy correctly transforms `Authorization: Bearer`
 * headers to `x-api-key` before forwarding requests to the GLM API.
 *
 * Uses native http module for requests to avoid nock/MSW fetch interception.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'http';
import nock from 'nock';

// Allow all localhost connections for proxy tests since the proxy
// makes outbound HTTP requests to the local mock target server.
beforeAll(() => {
  nock.enableNetConnect(/127\.0\.0\.1/);
});

import { GlmAuthProxy, startGlmAuthProxy, stopGlmAuthProxy } from './glm-auth-proxy.js';

/**
 * Helper to send a request through the proxy using native http module.
 */
function sendRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk.toString(); });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: responseBody,
          });
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('GlmAuthProxy', () => {
  let proxy: GlmAuthProxy;
  let mockTarget: Server;
  let mockTargetPort: number;

  // Mock GLM API target server that captures received headers
  const receivedRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];

  beforeAll(async () => {
    // Start a mock target server that records requests
    mockTarget = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedRequests.push({
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers as Record<string, string>,
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'test-response', content: [] }));
      });
    });

    await new Promise<void>((resolve) => {
      mockTarget.listen(0, '127.0.0.1', () => {
        const addr = mockTarget.address();
        if (typeof addr === 'object' && addr !== null) {
          mockTargetPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await mockTarget.close();
  });

  it('should start and return a proxy URL', async () => {
    proxy = new GlmAuthProxy(`http://127.0.0.1:${mockTargetPort}`);
    const proxyUrl = await proxy.start();

    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.isRunning()).toBe(true);

    await proxy.stop();
  });

  it('should throw if getProxyUrl() called before start', () => {
    const p = new GlmAuthProxy(`http://127.0.0.1:${mockTargetPort}`);
    expect(() => p.getProxyUrl()).toThrow('not running');
  });

  it('should stop cleanly', async () => {
    const p = new GlmAuthProxy(`http://127.0.0.1:${mockTargetPort}`);
    await p.start();
    expect(p.isRunning()).toBe(true);

    await p.stop();
    expect(p.isRunning()).toBe(false);
  });

  describe('header transformation', () => {
    let proxyPort: number;

    beforeAll(async () => {
      receivedRequests.length = 0;
      proxy = new GlmAuthProxy(`http://127.0.0.1:${mockTargetPort}`);
      const proxyUrl = await proxy.start();
      proxyPort = parseInt(proxyUrl.split(':').pop()!, 10);
    });

    afterAll(async () => {
      await proxy.stop();
    });

    it('should transform Authorization: Bearer to x-api-key', async () => {
      const response = await sendRequest(
        proxyPort,
        '/v1/messages',
        { 'Authorization': 'Bearer test-api-key-12345', 'anthropic-version': '2023-06-01' },
        JSON.stringify({ model: 'glm-5-turbo', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
      );

      expect(response.status).toBe(200);

      // Wait for the request to be recorded
      await new Promise((r) => setTimeout(r, 100));

      const received = receivedRequests[receivedRequests.length - 1];
      expect(received).toBeDefined();
      expect(received.headers['x-api-key']).toBe('test-api-key-12345');
      expect(received.headers['authorization']).toBeUndefined();
    });

    it('should forward non-Bearer Authorization header as-is', async () => {
      await sendRequest(
        proxyPort,
        '/v1/messages',
        { 'Authorization': 'Basic dGVzdDp0ZXN0' },
        JSON.stringify({ model: 'glm-5', max_tokens: 10, messages: [] })
      );

      await new Promise((r) => setTimeout(r, 100));

      const received = receivedRequests[receivedRequests.length - 1];
      expect(received).toBeDefined();
      expect(received.headers['authorization']).toBe('Basic dGVzdDp0ZXN0');
      expect(received.headers['x-api-key']).toBeUndefined();
    });

    it('should preserve other headers during forwarding', async () => {
      await sendRequest(
        proxyPort,
        '/v1/messages',
        {
          'Authorization': 'Bearer my-key',
          'anthropic-version': '2023-06-01',
          'x-custom-header': 'custom-value',
        },
        JSON.stringify({ model: 'glm-5', max_tokens: 10, messages: [] })
      );

      await new Promise((r) => setTimeout(r, 100));

      const received = receivedRequests[receivedRequests.length - 1];
      expect(received.headers['x-api-key']).toBe('my-key');
      expect(received.headers['content-type']).toContain('application/json');
      expect(received.headers['anthropic-version']).toBe('2023-06-01');
      expect(received.headers['x-custom-header']).toBe('custom-value');
    });

    it('should forward the request body correctly', async () => {
      const requestBody = JSON.stringify({
        model: 'glm-5-turbo',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello, world!' }],
      });

      await sendRequest(proxyPort, '/v1/messages', { 'Authorization': 'Bearer test-key' }, requestBody);

      await new Promise((r) => setTimeout(r, 100));

      const received = receivedRequests[receivedRequests.length - 1];
      expect(received.body).toBe(requestBody);
    });

    it('should forward the response back to the client', async () => {
      const response = await sendRequest(
        proxyPort,
        '/v1/messages',
        { 'Authorization': 'Bearer test-key' },
        JSON.stringify({ model: 'glm-5', max_tokens: 10, messages: [] })
      );

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('test-response');
    });
  });
});

describe('GlmAuthProxy singleton', () => {
  afterAll(async () => {
    await stopGlmAuthProxy();
  });

  it('should start and return proxy URL via singleton', async () => {
    const proxyUrl = await startGlmAuthProxy('http://127.0.0.1:19999');
    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('should return same URL on subsequent calls', async () => {
    const url1 = await startGlmAuthProxy('http://127.0.0.1:19999');
    const url2 = await startGlmAuthProxy('http://127.0.0.1:19999');
    expect(url1).toBe(url2);
  });

  it('should stop cleanly via singleton', async () => {
    await stopGlmAuthProxy();
    // Should be safe to call again
    await stopGlmAuthProxy();
  });
});
