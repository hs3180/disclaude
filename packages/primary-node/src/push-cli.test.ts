/**
 * Tests for push-cli — disclaude-push CLI entry point.
 *
 * Covers argument parsing, error handling, and the disconnect cleanup path.
 *
 * Issue #4543: push-cli is REST-only — the client is a directly-constructed
 * RestIpcClient, so the tests assert the transport is unconditional REST
 * (no getIpcClient facade, no UnixSocketIpcClient, no DISCLAUDE_REST_IPC_ENABLED
 * read, no socket fast-fail probe).
 *
 * @module primary-node/push-cli.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted runs before vi.mock factories, so mockPushToAgent is available.
const { mockPushToAgent, mockDisconnect, MockRestIpcClient } = vi.hoisted(() => ({
  mockPushToAgent: vi.fn(),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
  // Issue #4543: capture constructor options so tests can assert the transport
  // wiring (baseUrl from env, token from env) without a live HTTP server.
  MockRestIpcClient: vi.fn().mockImplementation((opts: unknown) => ({
    pushToAgent: mockPushToAgent,
    disconnect: mockDisconnect,
    __opts: opts,
  })),
}));

vi.mock('@disclaude/core', () => ({
  RestIpcClient: MockRestIpcClient,
  // Issue #4129: pushToAgent is a standalone function re-exported from
  // ipc-client-facade. The production code imports it directly, so the mock
  // must provide it too.
  pushToAgent: mockPushToAgent,
  // Issue #4543 anti-regression: the facade and socket symbols must exist for
  // other importers of the mocked module, but push-cli must never touch them.
  getIpcClient: vi.fn(),
  getIpcSocketPath: vi.fn(() => '/tmp/test.ipc'),
  UnixSocketIpcClient: vi.fn(),
}));

import { parseArgs, main } from './push-cli.js';
import { getIpcClient, getIpcSocketPath, UnixSocketIpcClient } from '@disclaude/core';

describe('push-cli', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    // Clear call history without resetting implementations
    mockPushToAgent.mockClear();
    mockDisconnect.mockClear();
    MockRestIpcClient.mockClear();
    vi.mocked(getIpcClient).mockClear();
    vi.mocked(getIpcSocketPath).mockClear();
    vi.mocked(UnixSocketIpcClient).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); }) as any;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalArgv = process.argv;
    mockDisconnect.mockResolvedValue(undefined);
    mockPushToAgent.mockResolvedValue({ success: true });
    // Issue #4543: transport must not depend on any env — start from a clean
    // slate each test; specific tests set what they need.
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

    // ── Issue #4543: unconditional REST transport ──────────────────────────

    it('constructs a RestIpcClient directly with all env unset (no IPC fallback)', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(MockRestIpcClient).toHaveBeenCalledTimes(1);
      expect(MockRestIpcClient).toHaveBeenCalledWith({ baseUrl: 'http://localhost:9200', apiToken: undefined });
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
    });

    it('never constructs a Unix-socket client — directly or via the getIpcClient facade', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(UnixSocketIpcClient).not.toHaveBeenCalled();
      expect(getIpcClient).not.toHaveBeenCalled();
      expect(getIpcSocketPath).not.toHaveBeenCalled();
    });

    it('is unaffected by DISCLAUDE_REST_IPC_ENABLED (env has no influence on transport)', async () => {
      process.env.DISCLAUDE_REST_IPC_ENABLED = 'false';
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      // Still the direct REST client — the flag neither enables nor disables anything.
      expect(MockRestIpcClient).toHaveBeenCalledTimes(1);
      expect(getIpcClient).not.toHaveBeenCalled();

      MockRestIpcClient.mockClear();
      process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
      await main();
      expect(MockRestIpcClient).toHaveBeenCalledTimes(1);
      expect(getIpcClient).not.toHaveBeenCalled();
    });

    it('wires DISCLAUDE_REST_IPC_BASE_URL / DISCLAUDE_REST_IPC_API_TOKEN into the client', async () => {
      process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://primary.internal:9300/';
      process.env.DISCLAUDE_REST_IPC_API_TOKEN = 'sekret';
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      // Trailing slash is the client's own normalization concern; the CLI
      // passes the env value through verbatim.
      expect(MockRestIpcClient).toHaveBeenCalledWith({ baseUrl: 'http://primary.internal:9300/', apiToken: 'sekret' });
    });

    it('help text documents REST-only transport and drops socket discovery', async () => {
      process.argv = ['node', 'push-cli'];
      await expect(main()).rejects.toThrow('process.exit');
      const usage = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
      expect(usage).toContain('REST only');
      expect(usage).toContain('DISCLAUDE_REST_IPC_BASE_URL');
      expect(usage).toContain('DISCLAUDE_REST_IPC_API_TOKEN');
      expect(usage).toContain('--api-port');
      expect(usage).not.toContain('--socket');
      expect(usage).not.toContain('Socket Discovery');
    });

    // ── Error paths ────────────────────────────────────────────────────────

    it('prints an actionable error with startup guidance when REST is unreachable (ipc_unavailable)', async () => {
      mockPushToAgent.mockResolvedValue({
        success: false,
        error: 'IPC_NOT_AVAILABLE: REST pushToAgent (fetch failed)',
        errorType: 'ipc_unavailable',
      });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      const calls = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
      expect(calls.some(c => c.includes('http://localhost:9200'))).toBe(true);
      expect(calls.some(c => c.includes('--api-port'))).toBe(true);
      expect(calls.some(c => c.includes('DISCLAUDE_REST_IPC_BASE_URL'))).toBe(true);
    });

    it('includes the configured base URL in the unreachable guidance', async () => {
      process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://primary.internal:9300';
      mockPushToAgent.mockResolvedValue({
        success: false,
        error: 'IPC_NOT_AVAILABLE: REST pushToAgent (fetch failed)',
        errorType: 'ipc_unavailable',
      });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      const calls = errorSpy.mock.calls.map((args: unknown[]) => String(args[0]));
      expect(calls.some(c => c.includes('http://primary.internal:9300'))).toBe(true);
    });

    // Issue #4280 (Phase 3) kept on #4543's REST-only ground: even when a
    // removed --socket flag is passed, the client is still the direct REST
    // client — no facade, no Unix socket, no socket fast-fail probe.
    it('routes through the direct REST client even when a removed --socket flag is passed', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello', '-s', '/custom.ipc'];
      await main();
      expect(MockRestIpcClient).toHaveBeenCalledTimes(1);
      expect(getIpcClient).not.toHaveBeenCalled();
      expect(UnixSocketIpcClient).not.toHaveBeenCalled();
      expect(getIpcSocketPath).not.toHaveBeenCalled();
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

    it('should log success on successful push and call disconnect', async () => {
      mockPushToAgent.mockResolvedValue({ success: true });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      // main() resolves normally on success (no process.exit)
      await main();
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should call disconnect in finally block after success', async () => {
      mockPushToAgent.mockResolvedValue({ success: true });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it('should suppress disconnect rejection without unhandled rejection', async () => {
      mockDisconnect.mockRejectedValue(new Error('socket already closed'));
      mockPushToAgent.mockResolvedValue({ success: true });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      // main() resolves normally — the void .catch(() => {}) swallows the disconnect error
      await main();
      expect(mockDisconnect).toHaveBeenCalled();
      // If we reach here without unhandled rejection, the defensive .catch() works
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
});
