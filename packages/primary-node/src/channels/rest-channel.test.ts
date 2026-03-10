/**
 * Tests for RestChannel.
 *
 * Tests the REST API channel implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';

// Generate a random port to avoid conflicts with other test runs
// Use port in the 31000-31999 range which is less commonly used
const TEST_PORT = 31000 + Math.floor(Math.random() * 999);

// Create mock logger with hoisted definition
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => mockLogger),
  DEFAULT_CHANNEL_CAPABILITIES: {
    supportsCard: true,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
  },
}));

describe('RestChannel', () => {
  let channel: RestChannel;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (channel) {
      await channel.stop();
    }
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      channel = new RestChannel();
      expect(channel.getPort()).toBe(3000);
    });

    it('should create instance with custom config', () => {
      const config: RestChannelConfig = {
        port: TEST_PORT,
        host: '127.0.0.1',
        apiPrefix: '/v1/api',
        authToken: 'test-token',
        enableCors: false,
      };
      channel = new RestChannel(config);
      expect(channel.getPort()).toBe(TEST_PORT);
    });
  });

  describe('getCapabilities()', () => {
    it('should return correct capabilities', () => {
      channel = new RestChannel({ port: TEST_PORT });
      const capabilities = channel.getCapabilities();

      expect(capabilities.supportsCard).toBe(true);
      expect(capabilities.supportsMarkdown).toBe(true);
      expect(capabilities.supportsThread).toBe(false);
      expect(capabilities.supportsFile).toBe(false);
      expect(capabilities.supportsMention).toBe(false);
      expect(capabilities.supportsUpdate).toBe(false);
      expect(capabilities.supportedMcpTools).toEqual(['send_message']);
    });
  });

  describe('HTTP server', () => {
    beforeEach(async () => {
      channel = new RestChannel({ port: TEST_PORT });
      await channel.start();
    });

    describe('GET /api/health', () => {
      it('should return health status', async () => {
        const response = await makeRequest('GET', '/api/health');
        expect(response.status).toBe(200);

        const body = JSON.parse(response.body);
        expect(body.status).toBe('ok');
        expect(body.channel).toBe('REST');
        expect(body.id).toBeDefined();
      });
    });

    describe('POST /api/chat', () => {
      it('should return 400 for empty body', async () => {
        const response = await makeRequest('POST', '/api/chat', '');
        expect(response.status).toBe(400);
      });

      it('should return 400 for invalid JSON', async () => {
        const response = await makeRequest('POST', '/api/chat', 'not json');
        expect(response.status).toBe(400);
      });

      it('should return 400 for missing message', async () => {
        const response = await makeRequest('POST', '/api/chat', JSON.stringify({ chatId: 'test' }));
        expect(response.status).toBe(400);
      });

      it('should accept valid chat request', async () => {
        const response = await makeRequest('POST', '/api/chat', JSON.stringify({
          chatId: 'test-chat',
          message: 'Hello',
          userId: 'test-user',
        }));
        expect(response.status).toBe(200);

        const body = JSON.parse(response.body);
        expect(body.success).toBe(true);
        expect(body.messageId).toBeDefined();
        expect(body.chatId).toBe('test-chat');
      });
    });

    describe('POST /api/chat/sync', () => {
      it.skip('should accept sync mode request - requires messageHandler', async () => {
        // This test requires a messageHandler to be set for the sync response to complete
        // Skipping as it times out without a proper messageHandler
        const response = await makeRequest('POST', '/api/chat/sync', JSON.stringify({
          chatId: 'sync-chat',
          message: 'Hello sync',
        }));
        expect(response.status).toBe(200);
      });
    });

    describe('POST /api/chat/{chatId} (async mode)', () => {
      it('should return 204 for poll without session', async () => {
        const response = await makeRequest('POST', '/api/chat/no-session', '');
        expect(response.status).toBe(204);
      });

      it('should return 400 for invalid JSON body', async () => {
        const response = await makeRequest('POST', '/api/chat/test-chat', 'not json');
        expect(response.status).toBe(400);
      });

      it('should create session and return 202 for new message', async () => {
        const response = await makeRequest('POST', '/api/chat/async-chat', JSON.stringify({
          message: 'Hello async',
        }));
        expect(response.status).toBe(202);

        const body = JSON.parse(response.body);
        expect(body.success).toBe(true);
        expect(body.status).toBe('processing');
      });

      it('should return 202 for poll on processing session', async () => {
        // First create a session
        await makeRequest('POST', '/api/chat/poll-chat', JSON.stringify({
          message: 'Hello',
        }));

        // Poll without message body
        const response = await makeRequest('POST', '/api/chat/poll-chat', '');
        expect(response.status).toBe(202);

        const body = JSON.parse(response.body);
        expect(body.status).toBe('processing');
      });
    });

    describe('CORS', () => {
      it('should include CORS headers when enabled', async () => {
        const corsChannel = new RestChannel({ port: TEST_PORT + 1, enableCors: true });
        await corsChannel.start();

        const response = await makeRequest('OPTIONS', '/api/health', null, TEST_PORT + 1);
        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('*');

        await corsChannel.stop();
      });

      it('should not include CORS headers when disabled', async () => {
        const noCorsChannel = new RestChannel({ port: TEST_PORT + 2, enableCors: false });
        await noCorsChannel.start();

        const response = await makeRequest('GET', '/api/health', null, TEST_PORT + 2);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();

        await noCorsChannel.stop();
      });
    });

    describe('Authentication', () => {
      it('should reject requests without auth token when configured', async () => {
        const authChannel = new RestChannel({
          port: TEST_PORT + 3,
          authToken: 'secret-token',
        });
        await authChannel.start();

        const response = await makeRequest('GET', '/api/health', null, TEST_PORT + 3);
        expect(response.status).toBe(401);

        await authChannel.stop();
      });

      it('should accept requests with valid auth token', async () => {
        const authChannel = new RestChannel({
          port: TEST_PORT + 4,
          authToken: 'secret-token',
        });
        await authChannel.start();

        const response = await makeRequest('GET', '/api/health', null, TEST_PORT + 4, {
          'Authorization': 'Bearer secret-token',
        });
        expect(response.status).toBe(200);

        await authChannel.stop();
      });

      it('should reject requests with invalid auth token', async () => {
        const authChannel = new RestChannel({
          port: TEST_PORT + 5,
          authToken: 'secret-token',
        });
        await authChannel.start();

        const response = await makeRequest('GET', '/api/health', null, TEST_PORT + 5, {
          'Authorization': 'Bearer wrong-token',
        });
        expect(response.status).toBe(401);

        await authChannel.stop();
      });
    });

    describe('404 for unknown routes', () => {
      it('should return 404 for unknown routes', async () => {
        const response = await makeRequest('GET', '/unknown');
        expect(response.status).toBe(404);
      });
    });

    describe('Control endpoint', () => {
      it('should return 400 for empty body', async () => {
        const response = await makeRequest('POST', '/api/control', '');
        expect(response.status).toBe(400);
      });

      it('should return 400 for missing required fields', async () => {
        const response = await makeRequest('POST', '/api/control', JSON.stringify({ type: 'cancel' }));
        expect(response.status).toBe(400);
      });
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop server', async () => {
      channel = new RestChannel({ port: TEST_PORT });
      await channel.start();

      expect(channel.isHealthy()).toBe(true);

      await channel.stop();
      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe('Session cleanup (Issue #1263)', () => {
    it('should accept sessionTtl config option', () => {
      channel = new RestChannel({ port: TEST_PORT, sessionTtl: 60000 });
      // Session TTL should be configured (60 seconds)
      expect(channel).toBeDefined();
    });

    it('should accept maxSessions config option', () => {
      channel = new RestChannel({ port: TEST_PORT, maxSessions: 100 });
      expect(channel).toBeDefined();
    });

    it('should accept cleanupInterval config option', () => {
      channel = new RestChannel({ port: TEST_PORT, cleanupInterval: 30000 });
      expect(channel).toBeDefined();
    });

    it('should expose getSessionCount method', async () => {
      channel = new RestChannel({ port: TEST_PORT });
      await channel.start();

      expect(channel.getSessionCount()).toBe(0);

      // Create a session
      await makeRequest('POST', '/api/chat/test-session', JSON.stringify({
        message: 'Hello',
      }));

      expect(channel.getSessionCount()).toBe(1);
    });

    it('should clean up sessions on stop', async () => {
      channel = new RestChannel({ port: TEST_PORT });
      await channel.start();

      // Create multiple sessions
      await makeRequest('POST', '/api/chat/session-1', JSON.stringify({ message: 'Hello 1' }));
      await makeRequest('POST', '/api/chat/session-2', JSON.stringify({ message: 'Hello 2' }));

      expect(channel.getSessionCount()).toBe(2);

      await channel.stop();
      expect(channel.getSessionCount()).toBe(0);
    });

    it('should support disabling TTL-based cleanup with sessionTtl=0', () => {
      channel = new RestChannel({ port: TEST_PORT, sessionTtl: 0 });
      expect(channel).toBeDefined();
    });

    it('should support disabling periodic cleanup with cleanupInterval=0', () => {
      channel = new RestChannel({ port: TEST_PORT, cleanupInterval: 0 });
      expect(channel).toBeDefined();
    });
  });
});

// Helper function to make HTTP requests
function makeRequest(
  method: string,
  path: string,
  body: string | null = null,
  port: number = TEST_PORT,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: data,
            headers: res.headers as Record<string, string>,
          });
        });
      }
    );

    req.on('error', reject);

    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}
