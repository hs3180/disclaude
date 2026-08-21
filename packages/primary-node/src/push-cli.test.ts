/**
 * Tests for push-cli — disclaude-push CLI entry point.
 *
 * Covers argument parsing, error handling, and the disconnect cleanup path.
 *
 * @module primary-node/push-cli.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted runs before vi.mock factories, so mockPushToAgent is available.
const { mockPushToAgent, mockDisconnect, mockGetIpcClient } = vi.hoisted(() => ({
  mockPushToAgent: vi.fn(),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
  // Issue #4280 (part 1): push-cli now resolves its client via getIpcClient() by
  // default (REST-transport compatible). The returned client only needs disconnect
  // for the finally cleanup — pushToAgent is module-mocked above.
  mockGetIpcClient: vi.fn(() => ({
    pushToAgent: mockPushToAgent,
    disconnect: mockDisconnect,
  })),
}));

vi.mock('@disclaude/core', () => ({
  // Issue #4280 (Phase 3): push-cli no longer constructs UnixSocketIpcClient
  // directly (the --socket override is removed); getIpcClient() is the only
  // construction path. Mock kept so an accidental re-introduction fails the
  // "does not construct UnixSocketIpcClient" assertion below.
  UnixSocketIpcClient: vi.fn().mockImplementation(() => ({
    pushToAgent: mockPushToAgent,
    disconnect: mockDisconnect,
  })),
  // Issue #4129: pushToAgent is now also a standalone function re-exported from ipc-client-facade.
  // The production code imports it directly, so the mock must provide it too.
  pushToAgent: mockPushToAgent,
  getIpcClient: mockGetIpcClient,
  getIpcSocketPath: vi.fn(() => '/tmp/test.ipc'),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { parseArgs, main } from './push-cli.js';
import { getIpcSocketPath, getIpcClient, UnixSocketIpcClient } from '@disclaude/core';
import { existsSync } from 'node:fs';

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
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); }) as any;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalArgv = process.argv;
    // Ensure default return values
    vi.mocked(existsSync).mockReturnValue(true);
    mockDisconnect.mockResolvedValue(undefined);
    mockPushToAgent.mockResolvedValue({ success: true });
    // Default: Unix-socket transport (REST IPC disabled). Tests that need REST
    // set the env var themselves and clean it up in afterEach.
    delete process.env.DISCLAUDE_REST_IPC_ENABLED;
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

    it('should exit(1) when socket file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('IPC socket not found'));
    });

    // Issue #4280 (part 1): by default push-cli resolves its client via the
    // central getIpcClient() facade instead of constructing a UnixSocketIpcClient
    // directly, so it stays in sync with the configured transport.
    it('should resolve the client via getIpcClient() by default', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(getIpcClient).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
    });

    // Issue #4280 (Phase 3): --socket no longer forces a Unix-socket client —
    // the facade resolves the transport and UnixSocketIpcClient is never
    // constructed directly by this CLI.
    it('should route through getIpcClient() even when a removed --socket flag is passed', async () => {
      process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello', '-s', '/custom.ipc'];
      await main();
      expect(getIpcClient).toHaveBeenCalledTimes(1);
      expect(UnixSocketIpcClient).not.toHaveBeenCalled();
      // REST mode skips the socket fast-fail entirely (no override path).
      expect(getIpcSocketPath).not.toHaveBeenCalled();
    });

    it('should never construct UnixSocketIpcClient directly', async () => {
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await main();
      expect(UnixSocketIpcClient).not.toHaveBeenCalled();
    });

    // Issue #4280 (part 1): under REST IPC mode there is no socket file, so the
    // Unix-socket fast-fail check must be skipped and the push proceed.
    it('should proceed under REST IPC mode even when socket file is absent', async () => {
      process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
      vi.mocked(existsSync).mockReturnValue(false);
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      // main() resolves normally on success (socket check skipped under REST)
      await main();
      expect(getIpcClient).toHaveBeenCalledTimes(1);
      expect(getIpcSocketPath).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
    });

    it('should log success on successful push and call disconnect', async () => {
      mockPushToAgent.mockResolvedValue({ success: true });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      // main() resolves normally on success (no process.exit)
      await main();
      expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
      expect(mockDisconnect).toHaveBeenCalled();
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

    it('should show Primary Node hint on ipc_unavailable', async () => {
      mockPushToAgent.mockResolvedValue({
        success: false,
        error: 'IPC unavailable',
        errorType: 'ipc_unavailable',
      });
      process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];
      await expect(main()).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Primary Node'));
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
