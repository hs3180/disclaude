/**
 * Tests for WorkerIpcServer - IPC Server for Worker Node.
 *
 * Tests cover:
 * - Server lifecycle: start, stop, double-start, double-stop
 * - Request handler setup
 * - Socket path configuration
 * - isRunning state tracking
 * - Connection handling: data processing, close, error
 * - Request parsing: valid JSON, invalid JSON, missing handler
 * - Response formatting
 *
 * Uses net.createServer for real socket testing but with mock request handlers
 * to avoid actual IPC protocol dependencies.
 *
 * @see worker-ipc-server.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock @disclaude/core
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    generateSocketPath: () => path.join(os.tmpdir(), `disclaude-test-${Date.now()}.ipc`),
  };
});

import { WorkerIpcServer } from './worker-ipc-server.js';
import type { IpcRequest, IpcResponse } from '@disclaude/core';

describe('WorkerIpcServer', () => {
  let server: WorkerIpcServer;
  let socketPath: string;

  beforeEach(() => {
    socketPath = path.join(os.tmpdir(), `test-worker-ipc-${Date.now()}.ipc`);
    server = new WorkerIpcServer({ socketPath });
  });

  afterEach(async () => {
    try {
      await server.stop();
    } catch {
      // ignore stop errors in cleanup
    }
  });

  // ============================================================================
  // Configuration
  // ============================================================================
  describe('configuration', () => {
    it('should use custom socket path from config', () => {
      const s = new WorkerIpcServer({ socketPath: '/tmp/custom.ipc' });
      expect(s.getSocketPath()).toBe('/tmp/custom.ipc');
    });

    it('should use default socket path when not provided', () => {
      const s = new WorkerIpcServer();
      expect(s.getSocketPath()).toContain('disclaude');
    });

    it('should not be running after construction', () => {
      expect(server.isRunning()).toBe(false);
    });
  });

  // ============================================================================
  // Request Handler
  // ============================================================================
  describe('setRequestHandler', () => {
    it('should accept a request handler function', () => {
      const handler = vi.fn();
      expect(() => server.setRequestHandler(handler)).not.toThrow();
    });
  });

  // ============================================================================
  // Start/Stop Lifecycle
  // ============================================================================
  describe('start', () => {
    it('should start successfully with a handler set', async () => {
      server.setRequestHandler(vi.fn());
      await server.start();

      expect(server.isRunning()).toBe(true);
    });

    it('should throw if no request handler is set', async () => {
      await expect(server.start()).rejects.toThrow('Request handler must be set before starting the server');
    });

    it('should warn and return if already started', async () => {
      server.setRequestHandler(vi.fn());
      await server.start();
      // Starting again should not throw
      await server.start();
      expect(server.isRunning()).toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop a running server', async () => {
      server.setRequestHandler(vi.fn());
      await server.start();
      expect(server.isRunning()).toBe(true);

      await server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('should be safe to call stop when not running', async () => {
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it('should be safe to call stop multiple times', async () => {
      server.setRequestHandler(vi.fn());
      await server.start();
      await server.stop();
      await server.stop(); // Should not throw
    });

    it('should clean up socket file on stop', async () => {
      server.setRequestHandler(vi.fn());
      await server.start();
      const sockPath = server.getSocketPath();

      await server.stop();

      // Socket file should be removed
      const exists = await fs.access(sockPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  // ============================================================================
  // Client Connection & Request Handling
  // ============================================================================
  describe('client connection', () => {
    it('should accept a client connection and respond to valid request', async () => {
      const handler = vi.fn().mockResolvedValue({
        id: 'req-1',
        success: true,
        data: { result: 'ok' },
      });
      server.setRequestHandler(handler);
      await server.start();

      // Connect as a client
      const response = await sendRequest(socketPath, {
        id: 'req-1',
        type: 'test',
        method: 'GET',
        params: {},
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'req-1', type: 'test' })
      );
      expect(response.success).toBe(true);
      expect(response.id).toBe('req-1');
    });

    it('should respond with error for invalid JSON', async () => {
      server.setRequestHandler(vi.fn());
      await server.start();

      const response = await sendRawData(socketPath, 'not valid json\n');

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid JSON');
      expect(response.id).toBe('unknown');
    });

    it('should respond with error when no handler configured during request', async () => {
      // Set handler to return but then we'll test the error path
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('Handler crashed');
      });
      server.setRequestHandler(handler);
      await server.start();

      const response = await sendRequest(socketPath, {
        id: 'req-err',
        type: 'test',
        method: 'GET',
        params: {},
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('Handler crashed');
      expect(response.id).toBe('req-err');
    });

    it('should handle multiple requests on the same connection', async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          id: `req-${callCount}`,
          success: true,
        });
      });
      server.setRequestHandler(handler);
      await server.start();

      const client = net.createConnection(socketPath);
      await new Promise<void>((resolve) => client.on('connect', resolve));

      const responses: IpcResponse[] = [];

      await new Promise<void>((resolve) => {
        let buffer = '';
        let received = 0;

        client.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.trim()) {
              responses.push(JSON.parse(line));
              received++;
              if (received === 2) {resolve();}
            }
          }
        });

        // Send two requests
        client.write(`${JSON.stringify({ id: 'req-1', type: 'test', method: 'GET', params: {} })  }\n`);
        client.write(`${JSON.stringify({ id: 'req-2', type: 'test', method: 'GET', params: {} })  }\n`);
      });

      expect(responses).toHaveLength(2);
      expect(responses[0].id).toBe('req-1');
      expect(responses[1].id).toBe('req-2');

      client.destroy();
    });

    it('should buffer partial data until complete line', async () => {
      const handler = vi.fn().mockResolvedValue({
        id: 'req-partial',
        success: true,
      });
      server.setRequestHandler(handler);
      await server.start();

      const response = await new Promise<IpcResponse>((resolve) => {
        const client = net.createConnection(socketPath, () => {
          let buffer = '';

          client.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (line.trim()) {
                resolve(JSON.parse(line));
              }
            }
          });

          // Send request in two parts
          const json = `${JSON.stringify({ id: 'req-partial', type: 'test', method: 'GET', params: {} })  }\n`;
          client.write(json.substring(0, 10));
          // Small delay to ensure partial delivery
          setTimeout(() => {
            client.write(json.substring(10));
          }, 50);
        });
      });

      expect(response.id).toBe('req-partial');
      expect(response.success).toBe(true);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================
  describe('edge cases', () => {
    it('should handle client disconnection gracefully', async () => {
      const handler = vi.fn().mockResolvedValue({ id: 'req-1', success: true });
      server.setRequestHandler(handler);
      await server.start();

      const client = net.createConnection(socketPath);
      await new Promise<void>((resolve) => client.on('connect', resolve));

      // Disconnect immediately
      client.destroy();

      // Server should still be running
      expect(server.isRunning()).toBe(true);
    });

    it('should handle request with non-Error thrown', async () => {
      const handler = vi.fn().mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw 'string error';  // Non-Error throw — testing source code's error handling
      });
      server.setRequestHandler(handler);
      await server.start();

      const response = await sendRequest(socketPath, {
        id: 'req-str-err',
        type: 'test',
        method: 'GET',
        params: {},
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('string error');
    });
  });
});

// ============================================================================
// Test Helpers
// ============================================================================

function sendRequest(socketPath: string, request: IpcRequest): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      let buffer = '';

      client.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              resolve(JSON.parse(line));
              client.destroy();
              return;
            } catch {
              // ignore parse errors, keep reading
            }
          }
        }
      });

      client.on('error', reject);

      client.write(`${JSON.stringify(request)  }\n`);
    });

    client.on('error', reject);
  });
}

function sendRawData(socketPath: string, data: string): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      let buffer = '';

      client.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              resolve(JSON.parse(line));
              client.destroy();
              return;
            } catch {
              // ignore parse errors
            }
          }
        }
      });

      client.on('error', reject);

      client.write(data);
    });

    client.on('error', reject);
  });
}
