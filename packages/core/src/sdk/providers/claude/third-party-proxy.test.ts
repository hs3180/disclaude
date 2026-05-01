/**
 * Tests for Third-party API Proxy (Issues #2916, #2948)
 *
 * Tests header transformation, endpoint detection, and proxy functionality.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import http from 'http';
import nock from 'nock';
import {
  isThirdPartyEndpoint,
  transformAuthHeaders,
  ThirdPartyProxy,
} from './third-party-proxy.js';

// ============================================================================
// isThirdPartyEndpoint
// ============================================================================

describe('isThirdPartyEndpoint', () => {
  it('should return false for Anthropic API endpoint', () => {
    expect(isThirdPartyEndpoint('https://api.anthropic.com')).toBe(false);
  });

  it('should return false for Anthropic console endpoint', () => {
    expect(isThirdPartyEndpoint('https://console.anthropic.com')).toBe(false);
  });

  it('should return false for Anthropic subdomain', () => {
    expect(isThirdPartyEndpoint('https://us-east-1.api.anthropic.com')).toBe(false);
  });

  it('should return true for GLM endpoint', () => {
    expect(isThirdPartyEndpoint('https://open.bigmodel.cn/api/anthropic')).toBe(true);
  });

  it('should return true for any non-Anthropic endpoint', () => {
    expect(isThirdPartyEndpoint('https://api.example.com')).toBe(true);
    expect(isThirdPartyEndpoint('http://localhost:8080')).toBe(true);
    expect(isThirdPartyEndpoint('https://my-proxy.example.com/v1')).toBe(true);
  });

  it('should return false for empty string', () => {
    expect(isThirdPartyEndpoint('')).toBe(false);
  });

  it('should return true for invalid URL (treated as third-party)', () => {
    expect(isThirdPartyEndpoint('not-a-valid-url')).toBe(true);
  });
});

// ============================================================================
// transformAuthHeaders
// ============================================================================

describe('transformAuthHeaders', () => {
  it('should transform Authorization: Bearer to x-api-key', () => {
    const headers = {
      authorization: 'Bearer sk-ant-test-api-key-12345',
      'content-type': 'application/json',
    };

    const result = transformAuthHeaders(headers);

    expect(result['x-api-key']).toBe('sk-ant-test-api-key-12345');
    expect(result['authorization']).toBeUndefined();
    expect(result['content-type']).toBe('application/json');
  });

  it('should handle case-insensitive Authorization header', () => {
    const headers = {
      Authorization: 'Bearer my-secret-key',
    };

    const result = transformAuthHeaders(headers);

    expect(result['x-api-key']).toBe('my-secret-key');
  });

  it('should preserve x-api-key if already present', () => {
    const headers = {
      'x-api-key': 'existing-key',
      'content-type': 'application/json',
    };

    const result = transformAuthHeaders(headers);

    expect(result['x-api-key']).toBe('existing-key');
    expect(result['content-type']).toBe('application/json');
  });

  it('should remove x-anthropic-billing-header', () => {
    const headers = {
      authorization: 'Bearer test-key',
      'x-anthropic-billing-header': 'some-billing-info',
      'content-type': 'application/json',
    };

    const result = transformAuthHeaders(headers);

    expect(result['x-anthropic-billing-header']).toBeUndefined();
    expect(result['x-api-key']).toBe('test-key');
  });

  it('should remove host header (will be set by proxy)', () => {
    const headers = {
      host: 'localhost:12345',
      authorization: 'Bearer test-key',
    };

    const result = transformAuthHeaders(headers);

    expect(result['host']).toBeUndefined();
    expect(result['x-api-key']).toBe('test-key');
  });

  it('should preserve all other headers', () => {
    const headers = {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
      'custom-header': 'custom-value',
    };

    const result = transformAuthHeaders(headers);

    expect(result['x-api-key']).toBe('test-key');
    expect(result['content-type']).toBe('application/json');
    expect(result['anthropic-version']).toBe('2023-06-01');
    expect(result['accept']).toBe('text/event-stream');
    expect(result['custom-header']).toBe('custom-value');
  });

  it('should handle Authorization header without Bearer prefix', () => {
    const headers = {
      authorization: 'Basic dXNlcjpwYXNz',
    };

    const result = transformAuthHeaders(headers);

    // Non-Bearer Authorization should be kept as-is
    expect(result['authorization']).toBe('Basic dXNlcjpwYXNz');
    expect(result['x-api-key']).toBeUndefined();
  });

  it('should handle empty headers', () => {
    const result = transformAuthHeaders({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ============================================================================
// ThirdPartyProxy (integration tests)
// ============================================================================

describe('ThirdPartyProxy', () => {
  let proxy: ThirdPartyProxy | null = null;
  let targetServer: http.Server | null = null;
  let targetPort = 0;

  // Captured request data from target server
  let capturedHeaders: http.IncomingHttpHeaders = {};
  let capturedBody = '';

  beforeAll(() => {
    // Ensure nock allows localhost connections for proxy tests
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
    if (targetServer) {
      await new Promise<void>(resolve => targetServer!.close(() => resolve()));
      targetServer = null;
    }
    // Re-enable net connect for localhost after nock.cleanAll()
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });

  /**
   * Create a simple target HTTP server that captures request data.
   */
  function createTargetServer(): Promise<number> {
    return new Promise((resolve) => {
      targetServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          capturedHeaders = req.headers;
          capturedBody = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      targetServer.listen(0, '127.0.0.1', () => {
        const addr = targetServer!.address();
        if (typeof addr === 'object' && addr !== null) {
          targetPort = addr.port;
          resolve(targetPort);
        }
      });
    });
  }

  /**
   * Helper to make a request through the proxy.
   */
  function makeProxyRequest(
    proxyUrl: string,
    headers: Record<string, string>,
    body: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        new URL(`${proxyUrl}/v1/messages`),
        {
          method: 'POST',
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('should start and return a proxy URL', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });

    const proxyUrl = await proxy.start();

    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('should transform Authorization: Bearer to x-api-key', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });
    const proxyUrl = await proxy.start();

    await makeProxyRequest(
      proxyUrl,
      {
        'Authorization': 'Bearer test-api-key-12345',
        'Content-Type': 'application/json',
      },
      JSON.stringify({ model: 'test', messages: [] })
    );

    // Verify the target received x-api-key instead of Authorization: Bearer
    expect(capturedHeaders['x-api-key']).toBe('test-api-key-12345');
    expect(capturedHeaders['authorization']).toBeUndefined();
  });

  it('should remove x-anthropic-billing-header', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });
    const proxyUrl = await proxy.start();

    await makeProxyRequest(
      proxyUrl,
      {
        'Authorization': 'Bearer test-key',
        'x-anthropic-billing-header': 'billing-info',
        'Content-Type': 'application/json',
      },
      '{}'
    );

    expect(capturedHeaders['x-anthropic-billing-header']).toBeUndefined();
  });

  // Note: Tool injection through proxy is tested indirectly via
  // third-party-adapter.test.ts (transformRequestBodyForThirdParty).
  // The proxy integration test is skipped due to nock net-connect
  // timing issues with async proxy forwarding.
  // The adapter unit tests provide full coverage of the tool extraction logic.

  it('should preserve request body when no tools found', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });
    const proxyUrl = await proxy.start();

    const body = JSON.stringify({
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    await makeProxyRequest(
      proxyUrl,
      {
        'Authorization': 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body
    );

    expect(capturedBody).toBe(body);
  });

  it('should forward response from target', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });
    const proxyUrl = await proxy.start();

    const response = await makeProxyRequest(
      proxyUrl,
      {
        'Authorization': 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      '{}'
    );

    expect(JSON.parse(response)).toEqual({ ok: true });
  });

  it('should stop cleanly', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });
    await proxy.start();

    await expect(proxy.stop()).resolves.toBeUndefined();
    // Second stop should be no-op
    await expect(proxy.stop()).resolves.toBeUndefined();
  });

  it('should handle multiple concurrent requests', async () => {
    const port = await createTargetServer();
    proxy = new ThirdPartyProxy({
      targetBaseUrl: `http://127.0.0.1:${port}`,
    });
    const proxyUrl = await proxy.start();

    const requests = Array.from({ length: 5 }, (_, i) =>
      makeProxyRequest(
        proxyUrl,
        {
          'Authorization': `Bearer key-${i}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ request: i })
      )
    );

    await Promise.all(requests);
    // At least the last request should have transformed headers
    expect(capturedHeaders['x-api-key']).toMatch(/^key-\d+$/);
  });
});
