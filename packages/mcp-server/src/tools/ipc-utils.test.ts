/**
 * Tests for IPC utility functions (packages/mcp-server/src/tools/ipc-utils.ts)
 * Issue #1617: Expanded coverage for isIpcAvailable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const mockGetIpcSocketPath = vi.fn().mockReturnValue('/tmp/test-ipc.sock');
const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};
const mockCreateLogger = vi.fn().mockReturnValue(mockLogger);

describe('getIpcErrorMessage', () => {
  let getIpcErrorMessage: typeof import('./ipc-utils.js').getIpcErrorMessage;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateLogger.mockReturnValue(mockLogger);
    vi.resetModules();
    const mod = await import('./ipc-utils.js');
    ({ getIpcErrorMessage } = mod);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  describe('ipc_unavailable error type', () => {
    it('should return IPC unavailable message', () => {
      const result = getIpcErrorMessage('ipc_unavailable');
      expect(result).toBe('❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。');
    });

    it('should ignore originalError for ipc_unavailable', () => {
      const result = getIpcErrorMessage('ipc_unavailable', 'some error');
      expect(result).toBe('❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。');
    });

    it('should ignore defaultMessage for ipc_unavailable', () => {
      const result = getIpcErrorMessage('ipc_unavailable', undefined, 'default msg');
      expect(result).toBe('❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。');
    });
  });

  describe('ipc_timeout error type', () => {
    it('should return IPC timeout message', () => {
      const result = getIpcErrorMessage('ipc_timeout');
      expect(result).toBe('❌ IPC 请求超时。服务可能过载，请稍后重试。');
    });

    it('should ignore originalError for ipc_timeout', () => {
      const result = getIpcErrorMessage('ipc_timeout', 'timeout after 30s');
      expect(result).toBe('❌ IPC 请求超时。服务可能过载，请稍后重试。');
    });
  });

  describe('ipc_request_failed error type', () => {
    it('should return IPC request failed message with original error', () => {
      const result = getIpcErrorMessage('ipc_request_failed', 'connection refused');
      expect(result).toBe('❌ IPC 请求失败: connection refused');
    });

    it('should return IPC request failed message without original error', () => {
      const result = getIpcErrorMessage('ipc_request_failed');
      expect(result).toBe('❌ IPC 请求失败: 未知错误');
    });

    it('should handle empty string original error', () => {
      const result = getIpcErrorMessage('ipc_request_failed', '');
      expect(result).toBe('❌ IPC 请求失败: ');
    });
  });

  describe('default/unknown error type', () => {
    it('should return default message when no error type is provided', () => {
      const result = getIpcErrorMessage(undefined, 'some error', '默认消息');
      expect(result).toBe('默认消息');
    });

    it('should return original error in default message when no defaultMessage is provided', () => {
      const result = getIpcErrorMessage(undefined, 'connection failed');
      expect(result).toBe('❌ 操作失败: connection failed');
    });

    it('should return generic error when nothing is provided', () => {
      const result = getIpcErrorMessage();
      expect(result).toBe('❌ 操作失败: 未知错误');
    });

    it('should handle unknown error type', () => {
      const result = getIpcErrorMessage('unknown_type', 'test error', 'fallback');
      expect(result).toBe('fallback');
    });

    it('should prefer defaultMessage over generated message for unknown types', () => {
      const result = getIpcErrorMessage('some_random_type', 'error details', 'Custom fallback');
      expect(result).toBe('Custom fallback');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string error type', () => {
      const result = getIpcErrorMessage('', 'error', 'default');
      expect(result).toBe('default');
    });

    it('should handle null-like string as error type', () => {
      const result = getIpcErrorMessage('null', 'error', 'default');
      expect(result).toBe('default');
    });
  });
});

describe('isIpcAvailable', () => {
  let isIpcAvailable: typeof import('./ipc-utils.js').isIpcAvailable;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateLogger.mockReturnValue(mockLogger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  describe('when socket file does not exist', () => {
    it('should return false immediately (fast path)', async () => {
      mockGetIpcSocketPath.mockReturnValue('/nonexistent/socket.sock');

      vi.doMock('@disclaude/core', () => ({
        getIpcSocketPath: (...args: unknown[]) => mockGetIpcSocketPath(...args),
        createLogger: (...args: unknown[]) => mockCreateLogger(...args),
      }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.resetModules();
      const mod = await import('./ipc-utils.js');
      ({ isIpcAvailable } = mod);

      const result = await isIpcAvailable();
      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'socket_not_found' }),
        expect.stringContaining('not available'),
      );
    });
  });

  describe('when socket file exists', () => {
    let mockSocket: EventEmitter & { destroy: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGetIpcSocketPath.mockReturnValue('/tmp/existing-ipc.sock');
      mockSocket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      mockSocket.destroy = vi.fn();
    });

    it('should return true when connection succeeds', async () => {
      vi.doMock('@disclaude/core', () => ({
        getIpcSocketPath: (...args: unknown[]) => mockGetIpcSocketPath(...args),
        createLogger: (...args: unknown[]) => mockCreateLogger(...args),
      }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock('net', () => ({
        createConnection: vi.fn().mockReturnValue(mockSocket),
      }));
      vi.resetModules();
      const mod = await import('./ipc-utils.js');
      ({ isIpcAvailable } = mod);

      const resultPromise = isIpcAvailable();

      // Simulate successful connection on next tick
      process.nextTick(() => {
        mockSocket.emit('connect');
      });

      const result = await resultPromise;
      expect(result).toBe(true);
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should return false when connection times out', async () => {
      vi.doMock('@disclaude/core', () => ({
        getIpcSocketPath: (...args: unknown[]) => mockGetIpcSocketPath(...args),
        createLogger: (...args: unknown[]) => mockCreateLogger(...args),
      }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock('net', () => ({
        createConnection: vi.fn().mockReturnValue(mockSocket),
      }));
      vi.resetModules();
      const mod = await import('./ipc-utils.js');
      ({ isIpcAvailable } = mod);

      vi.useFakeTimers();
      const resultPromise = isIpcAvailable();

      // Advance past the 1-second timeout
      await vi.advanceTimersByTimeAsync(1100);

      const result = await resultPromise;
      expect(result).toBe(false);
      expect(mockSocket.destroy).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should return false when connection errors', async () => {
      vi.doMock('@disclaude/core', () => ({
        getIpcSocketPath: (...args: unknown[]) => mockGetIpcSocketPath(...args),
        createLogger: (...args: unknown[]) => mockCreateLogger(...args),
      }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock('net', () => ({
        createConnection: vi.fn().mockReturnValue(mockSocket),
      }));
      vi.resetModules();
      const mod = await import('./ipc-utils.js');
      ({ isIpcAvailable } = mod);

      const resultPromise = isIpcAvailable();

      // Simulate connection error
      process.nextTick(() => {
        mockSocket.emit('error', new Error('ECONNREFUSED'));
      });

      const result = await resultPromise;
      expect(result).toBe(false);
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should return false when an unexpected exception occurs', async () => {
      vi.doMock('@disclaude/core', () => ({
        getIpcSocketPath: (...args: unknown[]) => mockGetIpcSocketPath(...args),
        createLogger: (...args: unknown[]) => mockCreateLogger(...args),
      }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
      }));
      vi.doMock('net', () => ({
        createConnection: vi.fn().mockImplementation(() => {
          throw new Error('Unexpected error');
        }),
      }));
      vi.resetModules();
      const mod = await import('./ipc-utils.js');
      ({ isIpcAvailable } = mod);

      const result = await isIpcAvailable();
      expect(result).toBe(false);
    });
  });
});
