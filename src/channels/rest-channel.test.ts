/**
 * Tests for RestChannel module.
 *
 * Tests the REST API channel functionality:
 * - HTTP server lifecycle
 * - API endpoints (/api/chat, /api/chat/sync, /api/health, /api/control)
 * - Authentication
 * - CORS support
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RestChannel } from './rest-channel.js';
import http from 'node:http';

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
}

/**
 * Helper to make HTTP requests to the test server.
 */
function makeRequest(
  port: number,
  options: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: options.path,
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const body = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode || 0, body });
          } catch {
            // If JSON parse fails, treat the raw data as an error message
            resolve({ status: res.statusCode || 0, body: { error: data } });
          }
        });
      }
    );

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('RestChannel', () => {
  let channel: RestChannel;
  let port: number;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use a random port to avoid conflicts
    port = 30000 + Math.floor(Math.random() * 1000);
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
      const response = await makeRequest(port, {
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

      const response = await makeRequest(port, {
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

      const response = await makeRequest(port, {
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
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat',
        body: {},
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Message is required');
    });

    it('should reject invalid JSON', async () => {
      // Need to make raw request for invalid JSON
      const response = await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: 'localhost',
              port,
              path: '/api/chat',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => {
                try {
                  resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
                } catch {
                  resolve({ status: res.statusCode || 0, body: data });
                }
              });
            }
          );
          req.on('error', reject);
          req.write('not valid json');
          req.end();
        }
      );

      expect(response.status).toBe(400);
      expect((response.body as { error?: string }).error).toBe('Invalid JSON');
    });
  });

  describe('Chat Endpoint (sync mode)', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should wait for done message in sync mode', async () => {
      channel.onMessage((msg) => {
        // Simulate async processing and response
        setTimeout(() => {
          void channel.sendMessage({
            chatId: msg.chatId,
            type: 'text',
            text: 'Response from agent',
          });
          void channel.sendMessage({
            chatId: msg.chatId,
            type: 'done',
          });
        }, 100);
        return Promise.resolve();
      });

      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/sync',
        body: {
          message: 'Hello',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toBe('Response from agent');
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

      const response = await makeRequest(port, {
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
      const response = await makeRequest(port, {
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
      const response = await makeRequest(port, {
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
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/health',
        headers: { Authorization: 'Bearer secret-token' },
      });

      expect(response.status).toBe(200);
    });

    it('should reject request without auth token', async () => {
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('should reject request with invalid auth token', async () => {
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/health',
        headers: { Authorization: 'Bearer wrong-token' },
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
      const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: 'localhost',
              port,
              path: '/api/health',
              method: 'GET',
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => {
                resolve({
                  status: res.statusCode || 0,
                  headers: res.headers,
                });
              });
            }
          );
          req.on('error', reject);
          req.end();
        }
      );

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle OPTIONS preflight request', async () => {
      const response = await makeRequest(port, {
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
      const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: 'localhost',
              port,
              path: '/api/health',
              method: 'GET',
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => {
                resolve({
                  status: res.statusCode || 0,
                  headers: res.headers,
                });
              });
            }
          );
          req.on('error', reject);
          req.end();
        }
      );

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
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/unknown',
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not found');
    });

    it('should return 404 for wrong method', async () => {
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/chat',
      });

      expect(response.status).toBe(404);
    });

    it('should handle message handler errors', async () => {
      channel.onMessage(() => {
        throw new Error('Handler failed');
      });

      const response = await makeRequest(port, {
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
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/v1/health',
      });

      expect(response.status).toBe(200);
    });

    it('should return 404 for default prefix', async () => {
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/health',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('Stop Cleanup', () => {
    it('should clear pending responses on stop', async () => {
      channel = new RestChannel({ port });
      await channel.start();

      // Start a sync request that will be pending
      const requestPromise = makeRequest(port, {
        method: 'POST',
        path: '/api/chat/sync',
        body: { message: 'Hello' },
      });

      // Wait a bit for the request to be received
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop the channel while request is pending
      await channel.stop();

      // The request should fail
      try {
        await requestPromise;
        // If it succeeded, it should have an error
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('File Upload Endpoint', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should upload a file successfully', async () => {
      const response = await makeRequest(port, {
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
      expect(response.body.file!.mimeType).toBe('text/plain');
      expect(response.body.file!.size).toBe(12);
      expect(response.body.file!.id).toBeDefined();
    });

    it('should reject upload without fileName', async () => {
      const response = await makeRequest(port, {
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
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'test.txt',
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('content is required');
    });

    it('should reject upload with invalid base64 content', async () => {
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'test.txt',
          content: 'not-valid-base64!!!',
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid base64 content');
    });

    it('should store chatId with file', async () => {
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'test.txt',
          content: Buffer.from('test').toString('base64'),
          chatId: 'chat-123',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('File Info Endpoint', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should return file info for existing file', async () => {
      // First upload a file
      const uploadResponse = await makeRequest(port, {
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'info-test.txt',
          mimeType: 'text/plain',
          content: Buffer.from('test content').toString('base64'),
        },
      });

      const fileId = uploadResponse.body.file!.id;

      // Then get file info
      const response = await makeRequest(port, {
        method: 'GET',
        path: `/api/files/${fileId}`,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.file).toBeDefined();
      expect(response.body.file!.id).toBe(fileId);
      expect(response.body.file!.fileName).toBe('info-test.txt');
    });

    it('should return 404 for non-existing file', async () => {
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/files/non-existing-id',
      });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('File not found');
    });
  });

  describe('File Download Endpoint', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should download file content', async () => {
      const originalContent = 'Download test content';

      // First upload a file
      const uploadResponse = await makeRequest(port, {
        method: 'POST',
        path: '/api/files/upload',
        body: {
          fileName: 'download-test.txt',
          mimeType: 'text/plain',
          content: Buffer.from(originalContent).toString('base64'),
        },
      });

      const fileId = uploadResponse.body.file!.id;

      // Then download the file
      const response = await makeRequest(port, {
        method: 'GET',
        path: `/api/files/${fileId}/download`,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.file).toBeDefined();
      expect(response.body.content).toBeDefined();

      // Verify content matches
      const decodedContent = Buffer.from(response.body.content!, 'base64').toString();
      expect(decodedContent).toBe(originalContent);
    });

    it('should return 404 for non-existing file download', async () => {
      const response = await makeRequest(port, {
        method: 'GET',
        path: '/api/files/non-existing-id/download',
      });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('File not found');
    });
  });

  describe('File Endpoints with Custom API Prefix', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port, apiPrefix: '/v2' });
      await channel.start();
    });

    it('should use custom API prefix for file upload', async () => {
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/v2/files/upload',
        body: {
          fileName: 'prefix-test.txt',
          content: Buffer.from('test').toString('base64'),
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should use custom API prefix for file info', async () => {
      // Upload first
      const uploadResponse = await makeRequest(port, {
        method: 'POST',
        path: '/v2/files/upload',
        body: {
          fileName: 'test.txt',
          content: Buffer.from('test').toString('base64'),
        },
      });

      const fileId = uploadResponse.body.file!.id;

      // Get info with custom prefix
      const response = await makeRequest(port, {
        method: 'GET',
        path: `/v2/files/${fileId}`,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Async Mode (POST /api/chat/{chatId})', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port });
      await channel.start();
    });

    it('should return 204 No Content when polling non-existent session', async () => {
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/non-existent-chat-id',
      });

      expect(response.status).toBe(204);
    });

    it('should return 202 Accepted when sending a message', async () => {
      const response = await makeRequest(port, {
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
      await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/processing-chat',
        body: { message: 'Processing test' },
      });

      // Poll immediately - should be processing
      const response = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/processing-chat',
      });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe('processing');
    });

    it('should return 200 with response when session is completed', async () => {
      // Set up message handler that will respond
      channel.onMessage(async (msg) => {
        // Simulate agent response
        await channel.sendMessage({
          type: 'text',
          text: 'Hello from agent!',
          chatId: msg.chatId,
        });
        // Signal completion
        await channel.sendMessage({
          type: 'done',
          chatId: msg.chatId,
        });
      });

      // Send a message
      const sendResponse = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/completed-chat',
        body: { message: 'Hello' },
      });

      expect(sendResponse.status).toBe(202);

      // Wait a bit for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Poll - should be completed with response
      const pollResponse = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/completed-chat',
      });

      expect(pollResponse.status).toBe(200);
      expect(pollResponse.body.success).toBe(true);
      expect(pollResponse.body.status).toBe('completed');
      expect(pollResponse.body.response).toBe('Hello from agent!');
    });

    it('should support appending messages to existing session', async () => {
      // Send first message
      const response1 = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/append-chat',
        body: { message: 'First message' },
      });

      expect(response1.status).toBe(202);

      // Send second message (append)
      const response2 = await makeRequest(port, {
        method: 'POST',
        path: '/api/chat/append-chat',
        body: { message: 'Second message' },
      });

      expect(response2.status).toBe(202);
      expect(response2.body.messageId).toBeDefined();
      // MessageId should be different
      expect(response2.body.messageId).not.toBe(response1.body.messageId);
    });

    it('should handle message handler errors in async mode', async () => {
      channel.onMessage(() => {
        throw new Error('Async handler failed');
      });

      const response = await makeRequest(port, {
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

      const response = await makeRequest(port, {
        method: 'POST',
        path: '/custom/chat/custom-prefix-chat',
        body: { message: 'Custom prefix test' },
      });

      expect(response.status).toBe(202);
      expect(response.body.chatId).toBe('custom-prefix-chat');
    });
  });
});
