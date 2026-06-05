/**
 * Tests for HttpApiServer.
 *
 * Issue #3857 Phase 2: HTTP API server for Primary Node.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpApiServer, type StatusResponse } from './http-api-server.js';

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
      const res = await fetch(`http://localhost:${port}/api/status`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as StatusResponse;
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
      expect(data.nodeId).toBe('test-node-1');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.version).toBeDefined();
    });

    it('should return JSON content type', async () => {
      const res = await fetch(`http://localhost:${port}/api/status`);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('should increase uptime over time', async () => {
      const res1 = await fetch(`http://localhost:${port}/api/status`);
      const data1 = (await res1.json()) as StatusResponse;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res2 = await fetch(`http://localhost:${port}/api/status`);
      const data2 = (await res2.json()) as StatusResponse;

      expect(data2.uptime).toBeGreaterThanOrEqual(data1.uptime);
    });
  });

  describe('unknown routes', () => {
    it('should return 404 for unknown paths', async () => {
      const res = await fetch(`http://localhost:${port}/unknown`);
      expect(res.status).toBe(404);

      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('Not found');
    });

    it('should return 404 for unknown API paths', async () => {
      const res = await fetch(`http://localhost:${port}/api/unknown`);
      expect(res.status).toBe(404);
    });
  });

  describe('lifecycle', () => {
    it('should report running after start', () => {
      expect(server.isRunning).toBe(true);
    });
  });
});
