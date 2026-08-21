/**
 * Tests for push-cli — disclaude-push CLI entry point.
 *
 * Covers argument parsing, error handling, and the disconnect cleanup path.
 *
 * Issue #4543: push-cli is REST-only. The tests assert the no-IPC contract:
 * unset env → still REST; DISCLAUDE_REST_IPC_ENABLED has no effect; no
 * Unix socket construction anywhere on the path (direct or via the facade).
 *
 * @module primary-node/push-cli.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted runs before vi.mock factories, so mockPushToAgent is available.
const { mockPushToAgent, mockDisconnect, mockGetIpcClient } = vi.hoisted(() => ({
  mockPushToAgent: vi.fn(),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
  // The core facade getIpcClient() — push-cli must NOT use it (Issue #4543:
  // it branches on DISCLAUDE_REST_IPC_ENABLED and would construct a
  // UnixSocketIpcClient when unset). Mocked so the "does not route through
  // the facade" assertion below fails loudly if it ever comes back.
  mockGetIpcClient: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => ({
  // Real RestIpcClient is imported by the production code; it only talks
  // HTTP at request time, and pushToAgent is mocked below, so no network
  // happens in tests. Use the actual implementation (importOriginal) so the
  // constructor/base-url/token handling is exercised for real — including
  // RestIpcClient.disconnect() (stateless no-op) on the finally path.
  ...(await importOriginal<typeof import('@disclaude/core')>()),
  // Anti-regression spies: if push-cli ever (re)introduces the facade path
  // or a direct UnixSocketIpcClient, these mocks record it.
  UnixSocketIpcClient: vi.fn(),
  // Issue #4129: pushToAgent is a standalone function re-exported from
  // ipc-client-facade. The production code imports it directly, so the mock
  // must provide it too.
  pushToAgent: mockPushToAgent,
  getIpcClient: mockGetIpcClient,
  getIpcSocketPath: vi.fn(() => '/tmp/test.ipc'),
}));

import { parseArgs, main } from './push-cli.js';
import { getIpcSocketPath, UnixSocketIpcClient, RestIpcClient } from '@disclaude/core';

describe('push-cli', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    // Clear call history without resetting implementations
    mockPushToAgent.mockClear();
    mockDisconnect.mockClear();
    mockGetIpcClient.mockClear();
    vi.mocked(getIpcSocketPath).mockClear();
    vi.mocked(UnixSocketIpcClient).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); }) as any;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalArgv = process.argv;
    mockDisconnect.mockResolvedValue(undefined);
    mockPushToAgent.mockResolvedValue({ success: true });
    // Issue #4543: unset every transport env by default — REST is now the
    // only behavior and must hold with a completely bare environment.
    delete process.env.DISCLAUDE_REST_IPC_ENABLED;
    delete process.env.DISCLAUDE_REST_IPC_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_API_TOKEN;
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe('parseArgs', () => {
    it('should parse long-form args', () => {
      const result = parseArgs(['--chat-id', 'oc_123', '--message', 'hello']);
      expect(result).toEqual({ chatId: 'oc_123', message: 'hello' });
    });

    it('should parse short-form args', () => {
      const result = parseArgs(['-c', 'oc_abc', '-m', 'world']);
      expect(result).toEqual({ chatId: 'oc_abc', message: 'world' });
    });

    // Issue #4280 (Phase 3): --socket/-s is removed along with the direct
    // UnixSocketIpcClient construction. Unknown flags are ignored by the
    // parser (pre-existing behaviour), so the flag no longer changes the
    // result — the options carry no socketPath at all.
    it('should ignore the removed --socket flag without a socketPath field', () => {
      const result = parseArgs(['-c', 'oc_abc', '-m', 'world', '-s', '/tmp/x.ipc']);
      expect(result).toEqual({ chatId: 'oc_abc', message: 'world' });
    });

    it('should call process.exit(1) when --chat-id is missing', () => {
      expect(() => parseArgs(['--message', 'hello'])).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should call process.exit(1) when --message is missing', () => {
      expect(() => parseArgs(['--chat-id', 'oc_test'])).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should call process.exit(1) when both required args are missing', () => {
      expect(() => parseArgs([])).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle --help flag', () => {
      expect(() => parseArgs(['--help'])).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('disclaude-push'));
    });

    it('should handle -h flag', () => {
      expect(() => parseArgs(['-h'])).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('main', () => {
    it('should print usage and exit(0) when no args provided', async () => {
      process.argv = ['node', 'push-cli'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('disclaude-push'));
    });

    it('should exit(1) when required args are missing', async () => {
      process.argv = ['node', 'push-cli', '--message', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    // Issue #4543 scope 1: with every transport env unset, push-cli still
    // pushes — via REST, with no IPC fallback and no socket existence check.
    it('should push via REST with all env unset (no IPC fallback)', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(mockPushToAgent).toHaveBeenCalledTimes(1);
      expect(mockGetIpcClient).not.toHaveBeenCalled();
      expect(getIpcSocketPath).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
    });

    // Issue #4543 scope 1: DISCLAUDE_REST_IPC_ENABLED no longer selects the
    // transport — push-cli is REST-only either way. Setting it must change
    // nothing (and, notably, must not route through the facade).
    it('should ignore DISCLAUDE_REST_IPC_ENABLED (REST either way)', async () => {
      process.env.DISCLAUDE_REST_IPC_ENABLED = 'false';
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(mockPushToAgent).toHaveBeenCalledTimes(1);
      expect(mockGetIpcClient).not.toHaveBeenCalled();
      expect(UnixSocketIpcClient).not.toHaveBeenCalled();

      mockPushToAgent.mockClear();
      mockGetIpcClient.mockClear();
      process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
      await main();
      expect(mockPushToAgent).toHaveBeenCalledTimes(1);
      expect(mockGetIpcClient).not.toHaveBeenCalled();
    });

    // Issue #4543 scope 6 (anti-regression, full-path): push-cli must never
    // produce a Unix socket client — neither directly nor indirectly via the
    // getIpcClient() facade. The facade is mocked to a spy and must stay
    // uncalled; UnixSocketIpcClient (also a spy) must never be constructed.
    it('should never construct a Unix socket client on any path', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(UnixSocketIpcClient).not.toHaveBeenCalled();
      expect(mockGetIpcClient).not.toHaveBeenCalled();
    });

    it('should log success on successful push and reach the finally cleanup', async () => {
      mockPushToAgent.mockResolvedValue({ success: true });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      // main() resolves normally on success (no process.exit)
      await main();
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
      // RestIpcClient.disconnect() is the real stateless no-op (importActual);
      // reaching a resolved main() proves the finally path ran without
      // throwing. mockDisconnect covers the legacy Unix-client shape only.
    });

    it('should exit(1) on pushToAgent failure with error details', async () => {
      mockPushToAgent.mockResolvedValue({
        success: false,
        error: 'Agent not found',
        errorType: 'ipc_request_failed',
      });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('push_to_agent failed [ipc_request_failed]'));
    });

    // Issue #4543 scope 3: a REST-unreachable failure (PrimaryNode not
    // started / no --api-port) must print the actionable guidance — base
    // URL, the --api-port startup flag, and the env override — instead of a
    // bare IPC hint.
    it('should print actionable REST guidance on ipc_unavailable', async () => {
      process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://localhost:9999';
      mockPushToAgent.mockResolvedValue({
        success: false,
        error: 'IPC_NOT_AVAILABLE: REST pushToAgent (fetch failed)',
        errorType: 'ipc_unavailable',
      });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      const calls = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
      expect(calls.some(c => c.includes('http://localhost:9999'))).toBe(true);
      expect(calls.some(c => c.includes('--api-port'))).toBe(true);
      expect(calls.some(c => c.includes('DISCLAUDE_REST_IPC_BASE_URL'))).toBe(true);
    });

    it('should show timeout hint on ipc_timeout', async () => {
      mockPushToAgent.mockResolvedValue({
        success: false,
        error: 'Timed out',
        errorType: 'ipc_timeout',
      });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      // Check that the timeout-specific hint was printed
      const calls = errorSpy.mock.calls.map((args: unknown[]) => args[0] as string);
      expect(calls.some(c => c.includes('timed out') || c.includes('busy'))).toBe(true);
    });

    it('should exit(1) on thrown exception with Error message', async () => {
      mockPushToAgent.mockRejectedValue(new Error('Connection refused'));
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Connection refused'));
    });

    it('should handle non-Error thrown values', async () => {
      mockPushToAgent.mockRejectedValue('string error');
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith('Error: string error');
    });

    it('should call disconnect in finally block after success', async () => {
      // Spy on the real (importActual) RestIpcClient.disconnect — the CLI's
      // finally path calls client.disconnect() on the REST client now.
      const disconnectSpy = vi.spyOn(RestIpcClient.prototype, 'disconnect')
        .mockResolvedValue(undefined);
      try {
        mockPushToAgent.mockResolvedValue({ success: true });
        process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
        await main();
        expect(disconnectSpy).toHaveBeenCalledTimes(1);
      } finally {
        disconnectSpy.mockRestore();
      }
    });

    it('should suppress disconnect rejection without unhandled rejection', async () => {
      const disconnectSpy = vi.spyOn(RestIpcClient.prototype, 'disconnect')
        .mockRejectedValue(new Error('socket already closed'));
      try {
        mockPushToAgent.mockResolvedValue({ success: true });
        process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
        // main() resolves normally — the void .catch(() => {}) swallows the disconnect error
        await main();
        expect(disconnectSpy).toHaveBeenCalled();
        // If we reach here without unhandled rejection, the defensive .catch() works
      } finally {
        disconnectSpy.mockRestore();
      }
    });

    it('should exit(1) when --message - is used in TTY mode', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', '-'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stdin'));
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });
  });

  describe('createRestClient (Issue #4543 scope 4: env wiring)', () => {
    it('should default the base URL and omit the token when env is unset', async () => {
      const { createRestClient } = await import('./push-cli.js');
      const client = createRestClient();
      expect(client).toBeInstanceOf(RestIpcClient);
      // baseUrl default: http://localhost:9200 (strip-trailing-slash form)
      expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://localhost:9200');
      expect((client as unknown as { apiToken?: string }).apiToken).toBeUndefined();
    });

    it('should read base URL and token from the shared REST env', async () => {
      process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://10.0.0.5:9201/';
      process.env.DISCLAUDE_REST_IPC_API_TOKEN = 'secret-token';
      const { createRestClient } = await import('./push-cli.js');
      const client = createRestClient();
      expect(client).toBeInstanceOf(RestIpcClient);
      // Trailing slash stripped by RestIpcClient
      expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://10.0.0.5:9201');
      expect((client as unknown as { apiToken?: string }).apiToken).toBe('secret-token');
    });
  });
});
