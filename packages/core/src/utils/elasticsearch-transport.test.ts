/**
 * Tests for Elasticsearch Transport (Issue #3720)
 *
 * Covers:
 * - buildIndexName: date-based index name generation
 * - ElasticsearchTransport: creation, buffering, flushing, error handling
 * - Auth header building (basic auth and API key)
 * - Retry and backoff logic
 * - Graceful shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElasticsearchTransport, buildIndexName } from './elasticsearch-transport.js';

/**
 * Helper to create a mock ES success response.
 */
function mockEsSuccessResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ errors: false }),
  };
}

/**
 * Helper to create a mock ES error response.
 */
function mockEsErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  };
}

describe('buildIndexName', () => {
  it('should generate date-suffixed index name', () => {
    const date = new Date('2026-05-19T12:00:00Z');
    const result = buildIndexName('disclaude-logs', date);
    expect(result).toBe('disclaude-logs-2026.05.19');
  });

  it('should use default prefix', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const result = buildIndexName('my-index', date);
    expect(result).toBe('my-index-2026.01.01');
  });

  it('should pad month and day with zeros', () => {
    const date = new Date('2026-03-05T00:00:00Z');
    const result = buildIndexName('logs', date);
    expect(result).toBe('logs-2026.03.05');
  });

  it('should default to current date when no date provided', () => {
    const result = buildIndexName('test-logs');
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    expect(result).toBe(`test-logs-${yyyy}.${mm}.${dd}`);
  });
});

describe('ElasticsearchTransport', () => {
  let transport: ElasticsearchTransport;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (transport) {
      transport.forceDestroy();
    }
  });

  describe('constructor', () => {
    it('should create transport with minimal config', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });

      expect(transport).toBeDefined();
      expect(transport.bufferSize).toBe(0);
      expect(transport.indexPrefix).toBe('disclaude-logs');
    });

    it('should use custom index prefix', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        index: 'custom-logs',
      });

      expect(transport.indexPrefix).toBe('custom-logs');
    });

    it('should not start flush timer when disabled', () => {
      transport = new ElasticsearchTransport({
        enabled: false,
        node: 'http://localhost:9200',
      });

      // Should not throw when writing despite being disabled
      transport.write('{"level":30,"msg":"test"}\n');
      expect(transport.bufferSize).toBe(0);
    });

    it('should start flush timer when enabled', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        flushInterval: 1000,
      });

      // Timer should be set up — advance time and verify flush was attempted
      const flushSpy = vi.spyOn(transport as any, 'flush');
      vi.advanceTimersByTime(1000);
      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('_write', () => {
    it('should buffer log entries as JSON objects', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });

      const entry = JSON.stringify({ level: 30, msg: 'test message', time: Date.now() });
      transport.write(entry);

      expect(transport.bufferSize).toBe(1);
    });

    it('should accept Buffer input', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });

      const entry = Buffer.from(JSON.stringify({ level: 30, msg: 'buffer test', time: Date.now() }));
      transport.write(entry);

      expect(transport.bufferSize).toBe(1);
    });

    it('should accept object input', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });

      const entry = { level: 30, msg: 'object test', time: Date.now() };
      transport.write(entry);

      expect(transport.bufferSize).toBe(1);
    });

    it('should skip buffering when disabled', () => {
      transport = new ElasticsearchTransport({
        enabled: false,
        node: 'http://localhost:9200',
      });

      transport.write('{"level":30,"msg":"test"}');
      expect(transport.bufferSize).toBe(0);
    });

    it('should add @timestamp field to entries', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        batchSize: 100, // Large enough to not auto-flush
      });

      const timestamp = new Date('2026-05-19T12:00:00Z').getTime();
      const entry = JSON.stringify({ level: 30, msg: 'test', time: timestamp });
      transport.write(entry);

      // Access internal buffer to verify @timestamp
      const buffer = (transport as any).buffer as Array<{ body: Record<string, unknown> }>;
      expect(buffer[0].body['@timestamp']).toBe('2026-05-19T12:00:00.000Z');
    });

    it('should use date-based index name from log timestamp', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        batchSize: 100,
      });

      const timestamp = new Date('2026-05-19T12:00:00Z').getTime();
      transport.write(JSON.stringify({ level: 30, msg: 'test', time: timestamp }));

      const buffer = (transport as any).buffer as Array<{ index: string }>;
      expect(buffer[0].index).toBe('disclaude-logs-2026.05.19');
    });

    it('should silently ignore malformed JSON', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });

      transport.write('not valid json');
      expect(transport.bufferSize).toBe(0);
    });

    it('should auto-flush when batch size is reached', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        batchSize: 2,
      });

      // Mock flush to prevent actual ES calls
      const flushSpy = vi.spyOn(transport as any, 'flush').mockResolvedValue(undefined);

      transport.write(JSON.stringify({ level: 30, msg: 'msg1', time: Date.now() }));
      expect(transport.bufferSize).toBe(1);

      transport.write(JSON.stringify({ level: 30, msg: 'msg2', time: Date.now() }));
      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should resolve immediately when buffer is empty', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
      });

      await expect(transport.flush()).resolves.toBeUndefined();
    });

    it('should send bulk request with buffered entries', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        retryOnError: false,
      });

      const mockFetch = vi.fn().mockResolvedValue(mockEsSuccessResponse());
      vi.stubGlobal('fetch', mockFetch);

      transport.write(JSON.stringify({ level: 30, msg: 'test1', time: Date.now() }));
      transport.write(JSON.stringify({ level: 40, msg: 'test2', time: Date.now() }));

      await transport.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const { calls } = mockFetch.mock;
      const [callArgs] = calls;
      const [url, options] = callArgs;
      expect(url).toContain('/_bulk');
      expect(options.method).toBe('POST');
      expect(options.body).toContain('"index"');
    });

    it('should retry on network failure when retryOnError is true', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        retryOnError: true,
        maxRetries: 2,
      });

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return Promise.resolve(mockEsErrorResponse(0, 'Connection refused'));
        }
        return Promise.resolve(mockEsSuccessResponse());
      });
      vi.stubGlobal('fetch', mockFetch);

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));

      const flushPromise = transport.flush();
      // Advance timers for backoff delay
      await vi.advanceTimersByTimeAsync(500);
      await flushPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 4xx client errors', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        retryOnError: true,
        maxRetries: 3,
      });

      const mockFetch = vi.fn().mockResolvedValue(mockEsErrorResponse(401, 'Unauthorized'));
      vi.stubGlobal('fetch', mockFetch);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      await transport.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('status 401'),
      );
    });

    it('should not retry when retryOnError is false', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        retryOnError: false,
      });

      const mockFetch = vi.fn().mockResolvedValue(mockEsErrorResponse(0, 'Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      await transport.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should clear buffer after successful flush', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        retryOnError: false,
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockEsSuccessResponse()));

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      expect(transport.bufferSize).toBe(1);

      await transport.flush();
      expect(transport.bufferSize).toBe(0);
    });
  });

  describe('authentication', () => {
    it('should include Basic auth header when username/password provided', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        auth: { username: 'elastic', password: 'changeme' },
        retryOnError: false,
      });

      const mockFetch = vi.fn().mockResolvedValue(mockEsSuccessResponse());
      vi.stubGlobal('fetch', mockFetch);

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      await transport.flush();

      const { calls } = mockFetch.mock;
      const [callArgs] = calls;
      const [, options] = callArgs;
      const encoded = Buffer.from('elastic:changeme').toString('base64');
      expect(options.headers['Authorization']).toBe(`Basic ${encoded}`);
    });

    it('should include ApiKey auth header when apiKey provided', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        auth: { username: 'elastic', password: 'changeme', apiKey: 'my-api-key' },
        retryOnError: false,
      });

      const mockFetch = vi.fn().mockResolvedValue(mockEsSuccessResponse());
      vi.stubGlobal('fetch', mockFetch);

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      await transport.flush();

      const { calls } = mockFetch.mock;
      const [callArgs] = calls;
      const [, options] = callArgs;
      expect(options.headers['Authorization']).toBe('ApiKey my-api-key');
    });

    it('should not include auth header when no auth configured', async () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        retryOnError: false,
      });

      const mockFetch = vi.fn().mockResolvedValue(mockEsSuccessResponse());
      vi.stubGlobal('fetch', mockFetch);

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      await transport.flush();

      const { calls } = mockFetch.mock;
      const [callArgs] = calls;
      const [, options] = callArgs;
      expect(options.headers['Authorization']).toBeUndefined();
    });
  });

  describe('forceDestroy', () => {
    it('should clean up timer and buffer', () => {
      transport = new ElasticsearchTransport({
        enabled: true,
        node: 'http://localhost:9200',
        flushInterval: 1000,
      });

      transport.write(JSON.stringify({ level: 30, msg: 'test', time: Date.now() }));
      expect(transport.bufferSize).toBe(1);

      transport.forceDestroy();
      expect(transport.bufferSize).toBe(0);
    });
  });
});
