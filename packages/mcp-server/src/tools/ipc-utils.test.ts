/**
 * Tests for IPC utility functions (packages/mcp-server/src/tools/ipc-utils.ts)
 */

import { describe, it, expect } from 'vitest';
import { getIpcErrorMessage } from './ipc-utils.js';

describe('getIpcErrorMessage', () => {
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
      // Empty string is truthy, so it's used as-is
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
