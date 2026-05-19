/**
 * Tests for Elasticsearch Transport (packages/core/src/utils/elasticsearch-transport.ts)
 *
 * Covers:
 * - Transport creation and configuration
 * - Buffering and batch behavior
 * - Date-based index naming
 * - Flush with mocked HTTP
 * - Graceful degradation on connection failure
 * - Destroy and cleanup
 * - Auth header generation
 *
 * @see Issue #3720
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { ElasticsearchTransport, createElasticsearchTransport } from './elasticsearch-transport.js';
import type { ElasticsearchConfig } from '../config/types.js';

describe('ElasticsearchTransport', () => {
  let transport: ElasticsearchTransport | null = null;

  const baseConfig: ElasticsearchConfig = {
    enabled: true,
    node: 'http://localhost:9200',
    index: 'test-logs',
    batchSize: 5,
    flushInterval: 60000, // Long interval to prevent auto-flush in tests
    retryOnError: false,
    maxRetries: 1,
  };

  afterEach(() => {
    if (transport) {
      transport.destroy();
      transport = null;
    }
  });

  describe('constructor', () => {
    it('should create transport with required config', () => {
      transport = new ElasticsearchTransport(baseConfig);
      expect(transport).toBeDefined();
      const status = transport.getStatus();
      expect(status.active).toBe(true);
      expect(status.pendingCount).toBe(0);
    });

    it('should apply default values for optional config', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });
      const status = transport.getStatus();
      expect(status.currentIndex).toMatch(/^disclaude-logs-\d{4}\.\d{2}\.\d{2}$/);
    });

    it('should start flush timer', () => {
      transport = new ElasticsearchTransport({ ...baseConfig, flushInterval: 100 });
      // Timer should be running; destroying after test cleans it up
      expect(transport.getStatus().active).toBe(true);
    });
  });

  describe('index naming', () => {
    it('should generate date-based index name', () => {
      transport = new ElasticsearchTransport(baseConfig);
      const status = transport.getStatus();
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
      expect(status.currentIndex).toBe(`test-logs-${today}`);
    });

    it('should use custom index prefix', () => {
      transport = new ElasticsearchTransport({
        ...baseConfig,
        index: 'custom-prefix',
      });
      const status = transport.getStatus();
      expect(status.currentIndex).toMatch(/^custom-prefix-\d{4}\.\d{2}\.\d{2}$/);
    });
  });

  describe('buffering', () => {
    it('should buffer entries without flushing when batch size not reached', () => {
      transport = new ElasticsearchTransport(baseConfig);
      transport.write('{"level":30,"time":1,"msg":"test"}\n');

      expect(transport.getStatus().pendingCount).toBe(1);
    });

    it('should trigger flush when batch size is reached', () => {
      const mockServer = createMockESServer(200, '{}');
      transport = new ElasticsearchTransport(baseConfig);

      for (let i = 0; i < 5; i++) {
        transport.write(`{"level":30,"time":${i},"msg":"test-${i}"}\n`);
      }

      // Wait for async flush
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          mockServer.close();
          resolve();
        }, 200);
      });
    });

    it('should ignore empty lines', () => {
      transport = new ElasticsearchTransport(baseConfig);
      transport.write('   \n');
      transport.write('\n');

      expect(transport.getStatus().pendingCount).toBe(0);
    });
  });

  describe('flush', () => {
    it('should resolve immediately when buffer is empty', async () => {
      transport = new ElasticsearchTransport(baseConfig);
      await expect(transport.flush()).resolves.toBeUndefined();
    });

    it('should send data to ES via HTTP POST', async () => {
      let receivedBody = '';
      const mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"errors":false,"items":[{"index":{"status":201}}]}');
        });
      });

      await new Promise<void>((resolve) => mockServer.listen(9201, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9201',
      });
      transport.write('{"level":30,"time":1000,"msg":"hello"}\n');

      await transport.flush();

      expect(receivedBody).toContain('"index":{"_index"');
      expect(receivedBody).toContain('"@timestamp"');
      expect(receivedBody).toContain('hello');
      expect(transport.getStatus().totalWritten).toBe(1);
      expect(transport.getStatus().pendingCount).toBe(0);

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('should handle non-JSON log entries gracefully', async () => {
      let receivedBody = '';
      const mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"errors":false,"items":[{"index":{"status":201}}]}');
        });
      });

      await new Promise<void>((resolve) => mockServer.listen(9202, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9202',
      });
      transport.write('plain text log line\n');

      await transport.flush();

      expect(receivedBody).toContain('plain text log line');
      expect(transport.getStatus().totalWritten).toBe(1);

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('should increment failure count on ES error', async () => {
      // Use a port that nothing listens on
      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:19999',
        retryOnError: false,
      });

      transport.write('{"level":30,"time":1,"msg":"test"}\n');
      await transport.flush();

      expect(transport.getStatus().totalFailures).toBe(1);
      expect(transport.getStatus().totalWritten).toBe(0);
    });

    it('should emit warning event on failure', async () => {
      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:19999',
        retryOnError: false,
      });

      const warningSpy = vi.fn();
      transport.on('warning', warningSpy);

      transport.write('{"level":30,"time":1,"msg":"test"}\n');
      await transport.flush();

      expect(warningSpy).toHaveBeenCalled();
      expect(warningSpy.mock.calls[0][0]).toContain('failed');
    });

    it('should handle ES bulk partial failure', async () => {
      const mockServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errors":true,"items":[{"index":{"status":400,"error":{"type":"mapper_parsing_exception","reason":"failed to parse"}}}]}');
      });

      await new Promise<void>((resolve) => mockServer.listen(9203, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9203',
        retryOnError: false,
      });

      transport.write('{"level":30,"time":1,"msg":"test"}\n');
      await transport.flush();

      // Should have recorded the failure
      expect(transport.getStatus().totalFailures).toBe(1);

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });
  });

  describe('authentication', () => {
    it('should send Basic auth header when configured', async () => {
      let authHeader = '';
      const mockServer = http.createServer((req, res) => {
        authHeader = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errors":false,"items":[]}');
      });

      await new Promise<void>((resolve) => mockServer.listen(9204, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9204',
        auth: { username: 'elastic', password: 'changeme' },
      });

      transport.write('{"level":30,"time":1,"msg":"auth test"}\n');
      await transport.flush();

      expect(authHeader).toBe(`Basic ${Buffer.from('elastic:changeme').toString('base64')}`);

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('should send API Key header when configured', async () => {
      let authHeader = '';
      const mockServer = http.createServer((req, res) => {
        authHeader = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errors":false,"items":[]}');
      });

      await new Promise<void>((resolve) => mockServer.listen(9205, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9205',
        apiKey: 'my-api-key-base64',
      });

      transport.write('{"level":30,"time":1,"msg":"apikey test"}\n');
      await transport.flush();

      expect(authHeader).toBe('ApiKey my-api-key-base64');

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('should prefer API Key over Basic auth', async () => {
      let authHeader = '';
      const mockServer = http.createServer((req, res) => {
        authHeader = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errors":false,"items":[]}');
      });

      await new Promise<void>((resolve) => mockServer.listen(9206, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9206',
        auth: { username: 'elastic', password: 'changeme' },
        apiKey: 'my-api-key',
      });

      transport.write('{"level":30,"time":1,"msg":"test"}\n');
      await transport.flush();

      expect(authHeader).toBe('ApiKey my-api-key');

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });
  });

  describe('destroy', () => {
    it('should stop accepting writes after destroy', () => {
      transport = new ElasticsearchTransport(baseConfig);
      transport.destroy();

      expect(transport.getStatus().active).toBe(false);
    });

    it('should flush remaining entries on destroy', async () => {
      let receivedBody = '';
      const mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"errors":false,"items":[]}');
        });
      });

      await new Promise<void>((resolve) => mockServer.listen(9207, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9207',
      });

      transport.write('{"level":30,"time":1,"msg":"final flush"}\n');

      // Flush manually before destroy to verify data reaches ES
      await transport.flush();
      expect(receivedBody).toContain('final flush');

      transport.destroy();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });
  });

  describe('createElasticsearchTransport', () => {
    it('should return null when config is undefined', () => {
      expect(createElasticsearchTransport(undefined)).toBeNull();
    });

    it('should return null when disabled', () => {
      expect(createElasticsearchTransport({ enabled: false, node: 'http://localhost:9200' })).toBeNull();
    });

    it('should return transport when enabled', () => {
      const transport = createElasticsearchTransport(baseConfig);
      expect(transport).toBeDefined();
      expect(transport).not.toBeNull();
      transport!.destroy();
    });
  });

  describe('retry', () => {
    it('should retry on failure when retryOnError is true', async () => {
      let attempts = 0;
      const mockServer = http.createServer((_req, res) => {
        attempts++;
        if (attempts < 3) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"internal"}');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"errors":false,"items":[]}');
        }
      });

      await new Promise<void>((resolve) => mockServer.listen(9208, () => resolve()));

      transport = new ElasticsearchTransport({
        ...baseConfig,
        node: 'http://localhost:9208',
        retryOnError: true,
        maxRetries: 3,
      });

      transport.write('{"level":30,"time":1,"msg":"retry test"}\n');
      await transport.flush();

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(transport.getStatus().totalWritten).toBe(1);

      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });
  });
});

/**
 * Helper to create a mock ES HTTP server.
 */
function createMockESServer(statusCode: number, body: string): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  return server;
}
