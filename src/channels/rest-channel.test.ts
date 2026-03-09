/**
 * Tests for RestChannel module.
 *
 * Tests the REST API channel functionality:
 * - HTTP server lifecycle
 * - API endpoints (/api/chat, /api/chat/sync, /api/health, /api/control)
 * - Authentication
 * - CORS support
 * - Error handling
 *
 * @see Issue #1023 - Unit tests should not depend on external environment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RestChannel } from './rest-channel.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

// Mock FileStorageService to avoid file system dependency
vi.mock('../file-transfer/index.js', () => ({
  FileStorageService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
    storeFromBase64: vi.fn().mockResolvedValue({
      id: 'mock-file-id',
      fileName: 'test.txt',
      mimeType: 'text/plain',
      size: 12,
      source: 'user',
      createdAt: Date.now(),
    }),
    get: vi.fn().mockReturnValue({
      ref: {
        id: 'mock-file-id',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        size: 12,
        source: 'user',
        createdAt: Date.now(),
      },
    }),
    getContent: vi.fn().mockResolvedValue(Buffer.from('test content').toString('base64')),
  })),
}));

/**
 * Mock HTTP server for testing without real network.
 */
class MockServer extends EventEmitter {
  listen = vi.fn((_port: number, _host: string, callback?: () => void) => {
    // Call callback immediately (synchronously) to avoid timer dependency
    if (callback) {
      callback();
    }
    return this;
  });

  close = vi.fn((callback?: () => void) => {
    if (callback) {
      callback();
    }
    return this;
  });
}

// Store reference to mock server instance and request handler
let mockServerInstance: MockServer | null = null;
let requestHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

// Mock node:http module to avoid real network dependency
vi.mock('node:http', () => ({
  default: {
    createServer: vi.fn().mockImplementation((handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      mockServerInstance = new MockServer();
      requestHandler = handler;
      return mockServerInstance;
    }),
  },
}));

/**
 * API response body type for test requests.
 */
interface ApiResponseBody {
  success?: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
  message?: string;
  response?: string;
  channel?: string;
  id?: string;
  status?: string;
  file?: {
    id?: string;
    fileName?: string;
    mimeType?: string;
    size?: number;
    source?: string;
    createdAt?: number;
  };
  content?: string;
}

/**
 * API response type for test requests.
 */
interface ApiResponse {
  status: number;
  body: ApiResponseBody;
  headers: Record<string, string>;
}

/**
 * Create a mock IncomingMessage for testing.
 */
function createMockRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { body?: string };
  req.method = options.method;
  req.url = options.url;
  req.headers = options.headers || {};
  req.body = options.body || '';
  return req;
}

/**
 * Create a mock ServerResponse for testing.
 */
function createMockResponse(): ServerResponse & {
  _statusCode: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
} {
  const res = new EventEmitter() as ServerResponse & {
    _statusCode: number;
    _headers: Record<string, string>;
    _body: string;
    _ended: boolean;
  };

  res._headers = {};
  res._body = '';
  res._statusCode = 200;
  res._ended = false;

  // Use type assertion to bypass strict type checking for mock methods
  // The mock returns `res` with extra properties for testing purposes
  (res as unknown as Record<string, unknown>).writeHead = vi.fn().mockImplementation((statusCode: number, headers?: Record<string, string>) => {
    res._statusCode = statusCode;
    if (headers) {
      Object.assign(res._headers, headers);
    }
    return res;
  });

  (res as unknown as Record<string, unknown>).setHeader = vi.fn().mockImplementation((name: string, value: string | number | string[]) => {
    res._headers[name.toLowerCase()] = String(value);
    return res;
  });

  (res as unknown as Record<string, unknown>).getHeader = vi.fn().mockImplementation((name: string) => {
    return res._headers[name.toLowerCase()];
  });

  (res as unknown as Record<string, unknown>).removeHeader = vi.fn();

  (res as unknown as Record<string, unknown>).end = vi.fn().mockImplementation((data?: string | Buffer | unknown) => {
    if (data && typeof data === 'string') {
      res._body = data;
    } else if (data && Buffer.isBuffer(data)) {
      res._body = data.toString();
    }
    res._ended = true;
    res.emit('finish');
    return res;
  });

  return res;
}

/**
 * Simulate a request to the channel's request handler.
 */
async function simulateRequest(
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<ApiResponse> {
  if (!requestHandler) {
    throw new Error('Request handler not initialized');
  }

  const req = createMockRequest({
    method: options.method,
    url: options.path,
    headers: options.headers,
    body: options.body ? JSON.stringify(options.body) : '',
  });

  const res = createMockResponse();

  // Simulate request body events synchronously
  if (options.body) {
    // Emit data and end events before calling handler
    const bodyStr = JSON.stringify(options.body);
    process.nextTick(() => {
      req.emit('data', bodyStr);
      req.emit('end');
    });
  } else {
    process.nextTick(() => req.emit('end'));
  }

  // Call the request handler
  await requestHandler(req, res);

  // Wait for response to end
  if (!res._ended) {
    await new Promise<void>((resolve) => {
      res.on('finish', () => resolve());
      // Timeout fallback
      setTimeout(resolve, 100);
    });
  }

  // Parse response body
  let body: ApiResponseBody = {};
  if (res._body) {
    try {
      body = JSON.parse(res._body);
    } catch {
      body = { error: res._body };
    }
  }

  return {
    status: res._statusCode,
    headers: res._headers,
    body,
  };
}

describe('RestChannel', () => {
  let channel: RestChannel;
  let port: number;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use a random port (not actually used with mock server)
    port = 30000 + Math.floor(Math.random() * 1000);
    mockServerInstance = null;
    requestHandler = null;
  });

  afterEach(async () => {
    if (channel) {
      await channel.stop().catch(() => {});
    }
  });

  describe('Constructor', () => {
    it('should create instance with default config', () => {
      channel = new RestChannel();
      expect(channel.id).toBe('rest');
      expect(channel.name).toBe('REST');
      expect(channel.getPort()).toBe(3000);
    });

    it('should use custom port from config', () => {
      channel = new RestChannel({ port: 4000 });
      expect(channel.getPort()).toBe(4000);
    });

    it('should use custom id from config', () => {
      channel = new RestChannel({ id: 'custom-rest', port });
      expect(channel.id).toBe('custom-rest');
    });
  });

  describe('Lifecycle', () => {
    it('should start and stop successfully', async () => {
      channel = new RestChannel({ port });
      expect(channel.status).toBe('stopped');

      await channel.start();
      expect(channel.status).toBe('running');
      expect(channel.isHealthy()).toBe(true);

      await channel.stop();
      expect(channel.status).toBe('stopped');
      expect(channel.isHealthy()).toBe(false);
    });

    it('should not start twice', async () => {
      channel = new RestChannel({ port });
      await channel.start();

      // Second start should be a no-op
      await channel.start();
      expect(channel.status).toBe('running');
    });

    it('should not stop twice', async () => {
      channel = new RestChannel({ port });
      await channel.start();
      await channel.stop();

      // Second stop should be a no-op
      await channel.stop();
      expect(channel.status).toBe('stopped');
    });
  });

  describe('Health Check Endpoint', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should return health status', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        channel: 'REST',
        id: 'rest',
      });
    });
  });

  describe('Chat Endpoint (async mode)', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should accept valid chat request', async () => {
      // Register a mock message handler
      const messageHandler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(messageHandler);

      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat',
        body: {
          message: 'Hello, world!',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.messageId).toBeDefined();
      expect(response.body.chatId).toBeDefined();

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello, world!',
          messageType: 'text',
        })
      );
    });

    it('should use provided chatId', async () => {
      const messageHandler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(messageHandler);

      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat',
        body: {
          message: 'Hello',
          chatId: 'custom-chat-id',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.chatId).toBe('custom-chat-id');
    });

    it('should reject empty message', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat',
        body: {},
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Message is required');
    });
  });

  describe('Control Endpoint', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should handle control commands', async () => {
      const controlHandler = vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Command executed' });
      channel.onControl(controlHandler);

      const response = await simulateRequest({
        method: 'POST',
        path: '/api/control',
        body: {
          type: 'reset',
          chatId: 'test-chat',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Command executed');

      expect(controlHandler).toHaveBeenCalledWith({
        type: 'reset',
        chatId: 'test-chat',
      });
    });

    it('should reject control command without type', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/control',
        body: {
          chatId: 'test-chat',
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('type and chatId are required');
    });

    it('should reject control command without chatId', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/control',
        body: {
          type: 'reset',
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('type and chatId are required');
    });
  });

  describe('Authentication', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port, authToken: 'secret-token' });
      await channel.start();
    });

    it('should accept request with valid auth token', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
        headers: { authorization: 'Bearer secret-token' },
      });

      expect(response.status).toBe(200);
    });

    it('should reject request without auth token', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('should reject request with invalid auth token', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
        headers: { authorization: 'Bearer wrong-token' },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('CORS', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port, enableCors: true });
      await channel.start();
    });

    it('should include CORS headers in response', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle OPTIONS preflight request', async () => {
      const response = await simulateRequest({
        method: 'OPTIONS',
        path: '/api/chat',
      });

      expect(response.status).toBe(204);
    });
  });

  describe('CORS Disabled', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port, enableCors: false });
      await channel.start();
    });

    it('should not include CORS headers when disabled', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should return 404 for unknown routes', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/unknown',
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not found');
    });

    it('should return 404 for wrong method', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/chat',
      });

      expect(response.status).toBe(404);
    });

    it('should handle message handler errors', async () => {
      channel.onMessage(() => {
        throw new Error('Handler failed');
      });

      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat',
        body: { message: 'Hello' },
      });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to process message');
    });
  });

  describe('Custom API Prefix', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port, apiPrefix: '/v1' });
      await channel.start();
    });

    it('should use custom API prefix', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/v1/health',
      });

      expect(response.status).toBe(200);
    });

    it('should return 404 for default prefix', async () => {
      const response = await simulateRequest({
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('File Upload Endpoint', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should upload a file successfully', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'test.txt',
          mimeType: 'text/plain',
          content: Buffer.from('Hello World!').toString('base64'),
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.file).toBeDefined();
      expect(response.body.file!.fileName).toBe('test.txt');
    });

    it('should reject upload without fileName', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/files/upload',
        body: {
          content: Buffer.from('test').toString('base64'),
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('fileName is required');
    });

    it('should reject upload without content', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'test.txt',
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('content is required');
    });
  });

  describe('Async Mode (POST /api/chat/{chatId})', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should return 204 No Content when polling non-existent session', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat/non-existent-chat-id',
      });

      expect(response.status).toBe(204);
    });

    it('should return 202 Accepted when sending a message', async () => {
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat/test-chat-123',
        body: { message: 'Hello async' },
      });

      expect(response.status).toBe(202);
      expect(response.body.success).toBe(true);
      expect(response.body.chatId).toBe('test-chat-123');
      expect(response.body.status).toBe('processing');
      expect(response.body.messageId).toBeDefined();
    });

    it('should return 202 when polling a processing session', async () => {
      // Send a message first
      await simulateRequest({
        method: 'POST',
        path: '/api/chat/processing-chat',
        body: { message: 'Processing test' },
      });

      // Poll immediately - should be processing
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat/processing-chat',
      });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe('processing');
    });

    it('should handle message handler errors in async mode', async () => {
      channel.onMessage(() => {
        throw new Error('Async handler failed');
      });

      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat/error-chat',
        body: { message: 'This will fail' },
      });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to process message');
    });

    it('should work with custom API prefix', async () => {
      // Stop current channel first
      await channel.stop();

      // Create new channel with custom prefix
      channel = new RestChannel({ port, apiPrefix: '/custom' });
      await channel.start();

      const response = await simulateRequest({
        method: 'POST',
        path: '/custom/chat/custom-prefix-chat',
        body: { message: 'Custom prefix test' },
      });

      expect(response.status).toBe(202);
      expect(response.body.chatId).toBe('custom-prefix-chat');
    });
  });

  describe('Session Cleanup (Issue #1263)', () => {
    it('should accept sessionTtl config option', () => {
      channel = new RestChannel({ port, sessionTtl: 1800000 }); // 30 minutes
      expect(channel).toBeDefined();
    });

    it('should accept maxSessions config option', () => {
      channel = new RestChannel({ port, maxSessions: 5000 });
      expect(channel).toBeDefined();
    });

    it('should accept cleanupInterval config option', () => {
      channel = new RestChannel({ port, cleanupInterval: 30000 }); // 30 seconds
      expect(channel).toBeDefined();
    });

    it('should cleanup expired sessions on poll', async () => {
      // Create channel with very short TTL for testing
      channel = new RestChannel({
        port,
        sessionTtl: 100, // 100ms TTL
        cleanupInterval: 50, // Check every 50ms
      });
      await channel.start();

      // Create a session
      await simulateRequest({
        method: 'POST',
        path: '/api/chat/expiring-session',
        body: { message: 'Test' },
      });

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      // Poll the session - it should be cleaned up
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat/expiring-session',
      });

      // Session should be gone (204 No Content)
      expect(response.status).toBe(204);
    });

    it('should enforce max sessions limit', async () => {
      // Create channel with low max sessions limit
      channel = new RestChannel({
        port,
        maxSessions: 2,
        cleanupInterval: 50,
      });
      await channel.start();

      // Create 3 sessions
      await simulateRequest({
        method: 'POST',
        path: '/api/chat/session-1',
        body: { message: 'Session 1' },
      });

      await simulateRequest({
        method: 'POST',
        path: '/api/chat/session-2',
        body: { message: 'Session 2' },
      });

      await simulateRequest({
        method: 'POST',
        path: '/api/chat/session-3',
        body: { message: 'Session 3' },
      });

      // Wait for cleanup to run
      await new Promise(resolve => setTimeout(resolve, 100));

      // First session should be evicted (oldest)
      const response = await simulateRequest({
        method: 'POST',
        path: '/api/chat/session-1',
      });

      // Session 1 should be gone
      expect(response.status).toBe(204);
    });
  });
});
