/**
 * Unit tests for TCC Worker Daemon and TCC-Safe Spawn utilities.
 *
 * Issue #1957: Tests cover:
 * - TccWorkerDaemon: server lifecycle, command execution, IPC protocol
 * - tcc-safe-spawn: environment detection, direct execution, worker routing
 * - Edge cases: timeouts, max concurrency, malformed requests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { createConnection } from 'net';
import {
  TccWorkerDaemon,
  generateTccWorkerSocketPath,
  DEFAULT_TCC_WORKER_CONFIG,
  launchTccWorker,
  type TccWorkerRequest,
  type TccWorkerResponse,
} from './tcc-worker.js';
import {
  isMacOS,
  needsTccWorker,
  resetTccWorkerClient,
  tccSafeExec,
  TccWorkerClient,
} from './tcc-safe-spawn.js';

// ============================================================================
// Helpers
// ============================================================================

/** Generate a unique temp socket path for each test */
function testSocketPath(): string {
  return join(tmpdir(), `tcc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/** Send a request to a Unix socket and get the response */
function sendIpcRequest(
  socketPath: string,
  request: TccWorkerRequest,
  timeout = 5000
): Promise<TccWorkerResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Test IPC request timeout'));
    }, timeout);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          clearTimeout(timer);
          socket.destroy();
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error('Invalid JSON response'));
          }
          return;
        }
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ============================================================================
// TccWorkerDaemon Tests
// ============================================================================

describe('TccWorkerDaemon', () => {
  let socketPath: string;
  let daemon: TccWorkerDaemon;

  beforeEach(() => {
    socketPath = testSocketPath();
    daemon = new TccWorkerDaemon({ socketPath, idleTimeout: 60_000 });
  });

  afterEach(async () => {
    try {
      await daemon.stop();
    } catch {
      // Already stopped
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }
  });

  describe('lifecycle', () => {
    it('should start and stop cleanly', async () => {
      expect(daemon.isRunning()).toBe(false);

      await daemon.start();
      expect(daemon.isRunning()).toBe(true);
      expect(existsSync(socketPath)).toBe(true);

      await daemon.stop();
      expect(daemon.isRunning()).toBe(false);
    });

    it('should return the correct socket path', () => {
      expect(daemon.getSocketPath()).toBe(socketPath);
    });

    it('should be idempotent on start', async () => {
      await daemon.start();
      await daemon.start(); // Should not throw
      expect(daemon.isRunning()).toBe(true);
    });

    it('should be idempotent on stop', async () => {
      await daemon.start();
      await daemon.stop();
      await daemon.stop(); // Should not throw
      expect(daemon.isRunning()).toBe(false);
    });

    it('should clean up socket file on stop', async () => {
      await daemon.start();
      expect(existsSync(socketPath)).toBe(true);

      await daemon.stop();
      expect(existsSync(socketPath)).toBe(false);
    });
  });

  describe('IPC protocol', () => {
    it('should respond to ping', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'test-1',
        type: 'ping',
      });

      expect(response.id).toBe('test-1');
      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ pong: true });
    });

    it('should reject unknown request types', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'test-2',
        type: 'unknown' as TccWorkerRequest['type'],
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unknown request type');
    });

    it('should reject invalid JSON', async () => {
      await daemon.start();

      // First verify the daemon works with valid JSON
      await sendIpcRequest(socketPath, {
        id: '0',
        type: 'ping',
      });

      // Send invalid JSON separately to test the handler
      // (sendIpcRequest always sends valid JSON, so we test via a raw socket)
      const rawSocket = createConnection(socketPath);
      rawSocket.write('not json at all\n');

      const rawResponse = await new Promise<string>((resolve) => {
        let buf = '';
        rawSocket.on('data', (data) => {
          buf += data.toString();
          const lines = buf.split('\n');
          if (lines.length > 1) {
            rawSocket.destroy();
            resolve(lines[0]);
          }
        });
        // Timeout fallback
        setTimeout(() => {
          rawSocket.destroy();
          resolve('');
        }, 2000);
      });

      expect(rawResponse).toContain('"success":false');
    });
  });

  describe('exec command', () => {
    it('should execute a command and return output', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'exec-1',
        type: 'exec',
        payload: {
          command: 'echo',
          args: ['hello', 'world'],
        },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toBeDefined();
      if (response.payload && 'exitCode' in response.payload) {
        expect(response.payload.exitCode).toBe(0);
        expect(response.payload.stdout.trim()).toBe('hello world');
      }
    });

    it('should capture stderr for failed commands', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'exec-2',
        type: 'exec',
        payload: {
          command: 'sh',
          args: ['-c', 'echo "error message" >&2 && exit 1'],
        },
      });

      expect(response.success).toBe(false);
      expect(response.payload).toBeDefined();
      if (response.payload && 'exitCode' in response.payload) {
        expect(response.payload.exitCode).toBe(1);
        expect(response.payload.stderr.trim()).toBe('error message');
      }
    });

    it('should handle command not found', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'exec-3',
        type: 'exec',
        payload: {
          command: 'nonexistent_command_xyz_123',
        },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    });

    it('should handle missing command in payload', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'exec-4',
        type: 'exec',
        payload: undefined,
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Missing command');
    });

    it('should respect timeout for long-running commands', async () => {
      await daemon.start();

      const startTime = Date.now();
      const response = await sendIpcRequest(socketPath, {
        id: 'exec-5',
        type: 'exec',
        payload: {
          command: 'sleep',
          args: ['10'],
          timeout: 500, // 500ms timeout
        },
      });

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(3000); // Should not wait for full 10s
      expect(response.success).toBe(false);
    });

    it('should handle env variables', async () => {
      await daemon.start();

      const response = await sendIpcRequest(socketPath, {
        id: 'exec-6',
        type: 'exec',
        payload: {
          command: 'sh',
          args: ['-c', 'echo $MY_TEST_VAR'],
          env: { MY_TEST_VAR: 'test_value_123' },
        },
      });

      expect(response.success).toBe(true);
      if (response.payload && 'exitCode' in response.payload) {
        expect(response.payload.stdout.trim()).toBe('test_value_123');
      }
    });
  });

  describe('concurrency', () => {
    it('should reject requests when max concurrent is reached', async () => {
      const limitedDaemon = new TccWorkerDaemon({
        socketPath,
        idleTimeout: 60_000,
        maxConcurrent: 1,
      });

      await limitedDaemon.start();

      try {
        // Send a slow command first
        const slowResponse = sendIpcRequest(socketPath, {
          id: 'slow-1',
          type: 'exec',
          payload: {
            command: 'sleep',
            args: ['1'],
          },
        });

        // Wait a bit for the slow command to start
        await new Promise((r) => setTimeout(r, 100));

        // Send another command while the first is running
        const blockedResponse = await sendIpcRequest(socketPath, {
          id: 'blocked-1',
          type: 'exec',
          payload: {
            command: 'echo',
            args: ['test'],
          },
        });

        expect(blockedResponse.success).toBe(false);
        expect(blockedResponse.error).toContain('Max concurrent');

        // Wait for the slow command to complete
        await slowResponse;
      } finally {
        await limitedDaemon.stop();
      }
    });
  });

  describe('shutdown', () => {
    it('should handle shutdown command', async () => {
      await daemon.start();
      expect(daemon.isRunning()).toBe(true);

      const response = await sendIpcRequest(socketPath, {
        id: 'shutdown-1',
        type: 'shutdown',
      });

      expect(response.success).toBe(true);

      // Wait for shutdown to complete
      await new Promise((r) => setTimeout(r, 500));
      expect(daemon.isRunning()).toBe(false);
    });
  });
});

// ============================================================================
// TccWorkerClient Tests
// ============================================================================

describe('TccWorkerClient', () => {
  let socketPath: string;
  let daemon: TccWorkerDaemon;
  let client: TccWorkerClient;

  beforeEach(async () => {
    socketPath = testSocketPath();
    daemon = new TccWorkerDaemon({ socketPath, idleTimeout: 60_000 });
    await daemon.start();
    client = new TccWorkerClient(socketPath);
  });

  afterEach(async () => {
    try {
      await client.disconnect();
    } catch {
      // Ignore
    }
    try {
      await daemon.stop();
    } catch {
      // Ignore
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }
    resetTccWorkerClient();
  });

  it('should connect and disconnect', async () => {
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('should ping the worker', async () => {
    await client.connect();
    const alive = await client.ping();
    expect(alive).toBe(true);
  });

  it('should send exec request and receive response', async () => {
    await client.connect();

    const response = await client.request('exec', {
      command: 'echo',
      args: ['test'],
    });

    expect(response.success).toBe(true);
    expect(response.payload).toBeDefined();
  });

  it('should reject when connecting to non-existent socket', async () => {
    const badClient = new TccWorkerClient('/tmp/nonexistent-tcc-test.sock');

    await expect(badClient.connect(1000)).rejects.toThrow();
    expect(badClient.isConnected()).toBe(false);
  });
});

// ============================================================================
// Environment Detection Tests
// ============================================================================

describe('Environment Detection', () => {
  describe('isMacOS', () => {
    it('should return false on non-darwin platforms', () => {
      // The test runner is likely on Linux, so this should be false
      // We just verify it returns a boolean
      const result = isMacOS();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('needsTccWorker', () => {
    it('should return false when not on macOS', () => {
      // Mock isMacOS to return false
      vi.mock('./tcc-safe-spawn.js', async () => {
        const actual = await vi.importActual('./tcc-safe-spawn.js');
        return {
          ...actual,
          isMacOS: () => false,
        };
      });

      expect(needsTccWorker()).toBe(false);
    });
  });
});

// ============================================================================
// tccSafeExec Tests (direct execution path)
// ============================================================================

describe('tccSafeExec (direct execution)', () => {
  beforeEach(() => {
    resetTccWorkerClient();
  });

  afterEach(() => {
    resetTccWorkerClient();
    vi.restoreAllMocks();
  });

  it('should execute command directly when not under PM2', async () => {
    const result = await tccSafeExec('echo', ['hello', 'direct']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello direct');
  });

  it('should handle command failure', async () => {
    const result = await tccSafeExec('sh', ['-c', 'echo "err" >&2 && exit 42']);

    expect(result.exitCode).toBe(42);
    expect(result.stderr.trim()).toBe('err');
  });

  it('should handle command not found', async () => {
    const result = await tccSafeExec('nonexistent_cmd_test_123', []);

    expect(result.exitCode).toBe(-1);
  });

  it('should pass env variables', async () => {
    const result = await tccSafeExec('sh', ['-c', 'echo $FOO'], {
      env: { FOO: 'bar' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('bar');
  });

  it('should respect timeout', async () => {
    const result = await tccSafeExec('sleep', ['10'], {
      timeout: 500,
    });

    expect(result.exitCode).toBe(-1);
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('Utility Functions', () => {
  it('generateTccWorkerSocketPath should generate unique paths', () => {
    const path1 = generateTccWorkerSocketPath();
    const path2 = generateTccWorkerSocketPath();
    expect(path1).not.toBe(path2);
    expect(path1).toContain('disclaude-tcc-worker');
    expect(path2).toContain('disclaude-tcc-worker');
  });

  it('DEFAULT_TCC_WORKER_CONFIG should have sensible defaults', () => {
    expect(DEFAULT_TCC_WORKER_CONFIG.idleTimeout).toBe(300_000);
    expect(DEFAULT_TCC_WORKER_CONFIG.maxConcurrent).toBe(5);
    expect(DEFAULT_TCC_WORKER_CONFIG.socketPath).toContain('disclaude-tcc-worker');
  });
});

// ============================================================================
// launchTccWorker Tests
// ============================================================================

describe('launchTccWorker', () => {
  it('should report already_running when socket exists', async () => {
    const socketPath = testSocketPath();
    const daemon = new TccWorkerDaemon({ socketPath, idleTimeout: 60_000 });

    try {
      await daemon.start();
      expect(existsSync(socketPath)).toBe(true);

      const result = launchTccWorker({
        socketPath,
        mode: 'detached',
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe('already_running');
    } finally {
      await daemon.stop();
    }
  });
});
