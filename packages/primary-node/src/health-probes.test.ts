import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { probeNetworkEndpoint } from './health-probes.js';

describe('probeNetworkEndpoint', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('reports DNS, HTTP status, and latency for a reachable endpoint', async () => {
    server = createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {throw new Error('test server did not bind');}

    const result = await probeNetworkEndpoint({ name: 'test', url: `http://127.0.0.1:${address.port}/health` });

    expect(result.status).toBe('healthy');
    expect(result.phase).toBe('http');
    expect(result.httpStatus).toBe(204);
    expect(result.resolvedAddresses).toContain('127.0.0.1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('distinguishes an HTTP client error from a transport failure', async () => {
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {throw new Error('test server did not bind');}

    const result = await probeNetworkEndpoint({ name: 'test', url: `http://127.0.0.1:${address.port}/missing` });

    expect(result.status).toBe('degraded');
    expect(result.phase).toBe('http');
    expect(result.errorType).toBe('http_4xx');
    expect(result.httpStatus).toBe(404);
  });

  it('marks an unset target as skipped', async () => {
    await expect(probeNetworkEndpoint({ name: 'optional' })).resolves.toEqual({ status: 'skipped' });
  });

  it('reports malformed targets without throwing from the monitor endpoint', async () => {
    const result = await probeNetworkEndpoint({ name: 'invalid', url: 'ftp://example.test' });
    expect(result.status).toBe('unhealthy');
    expect(result.errorType).toBe('invalid_target');
  });
});

