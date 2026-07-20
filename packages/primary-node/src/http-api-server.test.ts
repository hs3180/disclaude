/**
 * Tests for HttpApiServer.
 *
 * Issue #3857 Phase 2: HTTP API server for Primary Node.
 *
 * These are pure unit tests: request handling is exercised by driving the
 * server's request handler directly with mock request/response objects. No
 * real TCP socket is bound, so the suite is independent of `localhost`
 * IPv4/IPv6 resolution order and never contends for ports (see Issue #4142
 * review: binding a real socket made these tests flaky).
 *
 * Only the `lifecycle` group binds a real socket (on 127.0.0.1, port 0) to
 * verify start()/stop()/isRunning(); it makes no HTTP roundtrips.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { HttpApiServer, type StatusResponse, type PushResponse } from './http-api-server.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TopicGroupMessageEvent } from '@disclaude/core';

/** Options for building a mock request. */
interface MockRequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Mock IncomingMessage. Extends Readable so the body (if any) is delivered
 * naturally to any `on('data')` consumer (e.g. readBody), exactly like a real
 * request stream.
 */
class MockRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;

  constructor(opts: MockRequestOptions = {}) {
    super();
    this.method = opts.method ?? 'GET';
    this.url = opts.url ?? '/';
    this.headers = { host: '127.0.0.1', ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      this.push(Buffer.from(opts.body));
    }
    this.push(null);
  }

  _read(): void {
    // No-op: pushes in the constructor drive the stream.
  }
}

/**
 * Mock ServerResponse. Captures the status code, headers, and body that the
 * handler writes, so tests can assert on them without a real socket.
 */
class MockResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  writableEnded = false;

  writeHead(status: number, headers?: Record<string, unknown>): void {
    this.statusCode = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = String(value);
      }
    }
  }

  setHeader(key: string, value: unknown): void {
    this.headers[key.toLowerCase()] = String(value);
  }

  write(chunk: unknown): boolean {
    if (this.writableEnded) {
      return false;
    }
    this.chunks.push(Buffer.from(typeof chunk === 'string' ? chunk : String(chunk)));
    return true;
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined) {
      this.chunks.push(Buffer.from(typeof chunk === 'string' ? chunk : String(chunk)));
    }
    this.writableEnded = true;
    this.emit('finish');
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }
}

/** Drive the (private) request handler with a mock request and capture the response. */
async function dispatch(
  server: HttpApiServer,
  opts: MockRequestOptions
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const req = new MockRequest(opts) as unknown as IncomingMessage;
  const res = new MockResponse() as unknown as ServerResponse;
  // handleRequest is private; access it for unit testing without a socket.
  await (
    server as unknown as {
      handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    }
  ).handleRequest(req, res);
  const mockRes = res as unknown as MockResponse;
  return { statusCode: mockRes.statusCode, headers: mockRes.headers, body: mockRes.body };
}

describe('HttpApiServer', () => {
  let server: HttpApiServer;

  beforeEach(() => {
    server = new HttpApiServer({ port: 0, host: '127.0.0.1' });
    server.setNodeId('test-node-1');
    // start() sets startTime; since we never start() here, seed it so uptime
    // assertions are meaningful.
    (server as unknown as { startTime: number }).startTime = Date.now() - 5000;
  });

  afterEach(() => {
    // If any test opened an SSE stream, its keepalive heartbeat interval is
    // running; stop it so it cannot keep the process alive (stop() is a no-op
    // when start() was never called).
    (server as unknown as { stopSseHeartbeat: () => void }).stopSseHeartbeat();
  });

  describe('GET /api/status', () => {
    it('should return status ok', async () => {
      const { statusCode, body } = await dispatch(server, { method: 'GET', url: '/api/status' });
      expect(statusCode).toBe(200);

      const data = JSON.parse(body) as StatusResponse;
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
      expect(data.nodeId).toBe('test-node-1');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.version).toBeDefined();
    });

    it('should return JSON content type', async () => {
      const { headers } = await dispatch(server, { method: 'GET', url: '/api/status' });
      expect(headers['content-type']).toContain('application/json');
    });

    it('should increase uptime over time', async () => {
      const { body: body1 } = await dispatch(server, { method: 'GET', url: '/api/status' });
      const data1 = JSON.parse(body1) as StatusResponse;

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const { body: body2 } = await dispatch(server, { method: 'GET', url: '/api/status' });
      const data2 = JSON.parse(body2) as StatusResponse;

      expect(data2.uptime).toBeGreaterThanOrEqual(data1.uptime);
    });
  });

  describe('GET /api/ping (Issue #4279)', () => {
    it('should return pong ok', async () => {
      const { statusCode, body } = await dispatch(server, { method: 'GET', url: '/api/ping' });
      expect(statusCode).toBe(200);

      const data = JSON.parse(body) as { pong: boolean };
      expect(data.pong).toBe(true);
    });

    it('should return JSON content type', async () => {
      const { headers } = await dispatch(server, { method: 'GET', url: '/api/ping' });
      expect(headers['content-type']).toContain('application/json');
    });
  });

  describe('POST /api/send-message (Issue #4279)', () => {
    it('should delegate to the handler and return success + messageId', async () => {
      const mockHandler = vi.fn().mockResolvedValue({ success: true, messageId: 'om_123' });
      server.setSendMessageHandler(mockHandler);

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', text: 'hi', threadId: 'om_root', mentions: [{ openId: 'ou_a' }] }),
      });

      expect(statusCode).toBe(200);
      const data = JSON.parse(body) as { ok?: boolean; success?: boolean; messageId?: string };
      expect(data.ok).toBe(true);
      expect(data.success).toBe(true);
      expect(data.messageId).toBe('om_123');
      expect(mockHandler).toHaveBeenCalledWith('oc_test', 'hi', 'om_root', [{ openId: 'ou_a' }]);
    });

    it('should return 503 when handler is not configured', async () => {
      const { statusCode } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', text: 'hi' }),
      });
      expect(statusCode).toBe(503);
    });

    it('should return 400 when text is missing', async () => {
      server.setSendMessageHandler(vi.fn());
      const { statusCode } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test' }),
      });
      expect(statusCode).toBe(400);
    });

    it('should return 400 when chatId is missing', async () => {
      server.setSendMessageHandler(vi.fn());
      const { statusCode } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(statusCode).toBe(400);
    });

    it('should return 400 when chatId or text is empty', async () => {
      server.setSendMessageHandler(vi.fn());
      const { statusCode } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '', text: '' }),
      });
      expect(statusCode).toBe(400);
    });

    it('should return 400 when a mention is malformed', async () => {
      server.setSendMessageHandler(vi.fn());
      const { statusCode } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', text: 'hi', mentions: [{ name: 'no-open-id' }] }),
      });
      expect(statusCode).toBe(400);
    });

    it('should return 500 when the handler throws', async () => {
      server.setSendMessageHandler(vi.fn().mockRejectedValue(new Error('channel offline')));
      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/send-message',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', text: 'hi' }),
      });
      expect(statusCode).toBe(500);
      expect(JSON.parse(body).message).toContain('channel offline');
    });
  });

  describe('unknown routes', () => {
    it('should return 404 for unknown paths', async () => {
      const { statusCode, body } = await dispatch(server, { method: 'GET', url: '/unknown' });
      expect(statusCode).toBe(404);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toBe('Not found');
    });

    it('should return 404 for unknown API paths', async () => {
      const { statusCode } = await dispatch(server, { method: 'GET', url: '/api/unknown' });
      expect(statusCode).toBe(404);
    });
  });

  describe('HTTP method matching', () => {
    it('should return 404 for POST to GET-only route', async () => {
      const { statusCode } = await dispatch(server, { method: 'POST', url: '/api/status' });
      expect(statusCode).toBe(404);
    });
  });

  describe('POST /api/push', () => {
    it('should return 503 when push handler is not configured', async () => {
      // No pushHandler set on this server.
      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', message: 'hello' }),
      });

      expect(statusCode).toBe(503);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('not configured');
    });

    it('should accept push and call handler', async () => {
      const mockHandler = vi.fn().mockResolvedValue(undefined);
      server.setPushHandler(mockHandler);

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', message: 'hello world' }),
      });

      expect(statusCode).toBe(200);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(true);
      expect(data.message).toBe('Push accepted');
      expect(mockHandler).toHaveBeenCalledWith('oc_test', 'hello world');
    });

    it('should return 400 for invalid JSON', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Invalid JSON');
    });

    it('should return 400 for missing chatId', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Required fields');
    });

    it('should return 400 for missing message', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test' }),
      });

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Required fields');
    });

    it('should return 500 when handler throws', async () => {
      server.setPushHandler(() => Promise.reject(new Error('Agent not found')));

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', message: 'hello' }),
      });

      expect(statusCode).toBe(500);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('Agent not found');
    });

    it('should return 400 for empty chatId', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '', message: 'hello' }),
      });

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('non-empty');
    });

    it('should return 400 for empty message', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', message: '' }),
      });

      expect(statusCode).toBe(400);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('non-empty');
    });

    it('should return 413 for oversized body', async () => {
      server.setPushHandler(vi.fn());

      const { statusCode, body } = await dispatch(server, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', message: 'x'.repeat(1024 * 1024 + 1) }),
      });

      expect(statusCode).toBe(413);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(false);
      expect(data.message).toContain('too large');
    });
  });

  describe('API Token authentication (Issue #3857)', () => {
    const testToken = 'test-secret-token-123';
    let authServer: HttpApiServer;

    beforeEach(() => {
      authServer = new HttpApiServer({ port: 0, host: '127.0.0.1', apiToken: testToken });
      authServer.setPushHandler(vi.fn().mockResolvedValue(undefined));
    });

    afterEach(() => {
      (authServer as unknown as { stopSseHeartbeat: () => void }).stopSseHeartbeat();
    });

    it('should allow GET /api/status without token', async () => {
      const { statusCode } = await dispatch(authServer, { method: 'GET', url: '/api/status' });
      expect(statusCode).toBe(200);
    });

    it('should reject POST /api/push without token', async () => {
      const { statusCode, body } = await dispatch(authServer, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_test', message: 'hello' }),
      });

      expect(statusCode).toBe(401);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toBe('Unauthorized');
    });

    it('should reject POST /api/push with wrong token', async () => {
      const { statusCode } = await dispatch(authServer, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
        body: JSON.stringify({ chatId: 'oc_test', message: 'hello' }),
      });

      expect(statusCode).toBe(401);
    });

    it('should accept POST /api/push with correct token', async () => {
      const { statusCode, body } = await dispatch(authServer, {
        method: 'POST',
        url: '/api/push',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${testToken}` },
        body: JSON.stringify({ chatId: 'oc_test', message: 'hello' }),
      });

      expect(statusCode).toBe(200);
      const data = JSON.parse(body) as PushResponse;
      expect(data.ok).toBe(true);
    });
  });

  describe('GET /api/topic-stream (SSE) — Issue #4031', () => {
    it('should return SSE headers on connect', async () => {
      const { statusCode, headers } = await dispatch(server, {
        method: 'GET',
        url: '/api/topic-stream',
      });

      expect(statusCode).toBe(200);
      expect(headers['content-type']).toBe('text/event-stream');
      expect(headers['cache-control']).toBe('no-cache');
      expect(headers['x-accel-buffering']).toBe('no');
    });

    it('should send initial comment on connect', async () => {
      const { body } = await dispatch(server, { method: 'GET', url: '/api/topic-stream' });
      expect(body).toContain(': connected');
    });

    it('should broadcast TopicGroupMessageEvent to connected SSE client', async () => {
      // Connect a mock SSE client (registers it in the server's sseClients).
      const res = new MockResponse();
      const req = new MockRequest({
        method: 'GET',
        url: '/api/topic-stream',
      }) as unknown as IncomingMessage;
      await (
        server as unknown as {
          handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
        }
      ).handleRequest(req, res as unknown as ServerResponse);

      const event: TopicGroupMessageEvent = {
        type: 'topic_group_message',
        chatId: 'oc_test_chat',
        rootId: 'om_root',
        threadId: 'om_thread',
        sender: { name: 'TestUser' },
        content: 'Hello from topic',
        isReply: false,
        timestamp: new Date().toISOString(),
      };

      server.broadcastTopicEvent(event);

      const { body } = res;
      expect(body).toContain('data: ');
      const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse((dataLine as string).slice(6)) as TopicGroupMessageEvent;
      expect(parsed.type).toBe('topic_group_message');
      expect(parsed.chatId).toBe('oc_test_chat');
      expect(parsed.content).toBe('Hello from topic');
    });

    it('should handle no connected clients gracefully', () => {
      // No SSE client connected on this fresh server.
      expect(() => {
        server.broadcastTopicEvent({
          type: 'topic_group_message',
          chatId: 'oc_test',
          rootId: 'om_root',
          threadId: 'om_thread',
          sender: {},
          content: 'test',
          isReply: false,
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();
    });
  });

  describe('lifecycle', () => {
    // These verify start()/stop()/isRunning() and necessarily bind a real
    // socket — but on 127.0.0.1 with an OS-assigned port (port 0) and without
    // making any HTTP roundtrip, so they are deterministic and port-conflict
    // free regardless of localhost IPv4/IPv6 ordering.
    let lifecycleServer: HttpApiServer;

    beforeEach(async () => {
      lifecycleServer = new HttpApiServer({ port: 0, host: '127.0.0.1' });
      lifecycleServer.setNodeId('test-lifecycle');
      await lifecycleServer.start();
    });

    afterEach(async () => {
      await lifecycleServer.stop();
    });

    it('should report running after start', () => {
      expect(lifecycleServer.isRunning).toBe(true);
    });

    it('should handle start when already running', async () => {
      // Already started in beforeEach — calling start again should be a no-op.
      await lifecycleServer.start();
      expect(lifecycleServer.isRunning).toBe(true);
    });

    it('should report not running after stop', async () => {
      await lifecycleServer.stop();
      expect(lifecycleServer.isRunning).toBe(false);
    });

    it('should handle stop when already stopped', async () => {
      await lifecycleServer.stop();
      // Stopping again should be a no-op.
      await lifecycleServer.stop();
      expect(lifecycleServer.isRunning).toBe(false);
    });
  });
});
