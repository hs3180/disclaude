/**
 * IPC utility functions for MCP tools.
 *
 * Shared utilities for IPC availability checking and error message generation.
 *
 * @module mcp-server/tools/ipc-utils
 */

import { existsSync } from 'fs';
import { getIpcSocketPath, createLogger } from '@disclaude/core';

const logger = createLogger('IpcUtils');

/**
 * Check if IPC is available for Feishu API calls.
 * Issue #1035: Prefer IPC when available for unified client management.
 * Issue #1042: Use Worker Node IPC socket path if available.
 */
export function isIpcAvailable(): boolean {
  const socketPath = getIpcSocketPath();
  const available = existsSync(socketPath);
  logger.debug({ socketPath, available }, 'IPC availability check');
  return available;
}

/**
 * Generate user-friendly error message based on IPC error type.
 * Issue #1088: Provide actionable error messages.
 *
 * @param errorType - The type of IPC error
 * @param originalError - The original error message
 * @param defaultMessage - Default message if no specific error type matches
 * @returns User-friendly error message
 */
export function getIpcErrorMessage(
  errorType?: string,
  originalError?: string,
  defaultMessage?: string
): string {
  switch (errorType) {
    case 'ipc_unavailable':
      return '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。';
    case 'ipc_timeout':
      return '❌ IPC 请求超时。服务可能过载，请稍后重试。';
    case 'ipc_request_failed':
      return `❌ IPC 请求失败: ${originalError ?? '未知错误'}`;
    default:
      return defaultMessage ?? `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }
}
