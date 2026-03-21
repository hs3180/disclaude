/**
 * IPC utility functions for MCP tools.
 *
 * Shared utilities for IPC availability checking and error message generation.
 *
 * @module mcp-server/tools/ipc-utils
 */

import { existsSync } from 'fs';
import { createConnection } from 'net';
import { getIpcSocketPath, createLogger } from '@disclaude/core';

const logger = createLogger('IpcUtils');

/**
 * Check if IPC is available for Feishu API calls.
 * Issue #1035: Prefer IPC when available for unified client management.
 * Issue #1042: Use Worker Node IPC socket path if available.
 * Issue #1355: Use actual connection probing instead of file-existence check.
 *   The socket file may disappear while the process still holds the fd,
 *   or the file may exist but the server is not listening.
 *
 * This function performs a file-existence check first (fast path),
 * then attempts an actual connection to verify the server is alive.
 *
 * @returns Promise resolving to true if IPC server is reachable
 */
export async function isIpcAvailable(): Promise<boolean> {
  const socketPath = getIpcSocketPath();

  // Fast path: socket file must exist
  if (!existsSync(socketPath)) {
    logger.debug({ socketPath, reason: 'socket_not_found' }, 'IPC availability check: not available');
    return false;
  }

  // Issue #1355: Attempt actual connection to verify server is alive.
  // This detects cases where:
  // - Socket file exists but server is not listening (stale file)
  // - Socket file was cleaned up by OS while process holds the fd
  try {
    const available = await new Promise<boolean>((resolve) => {
      const client = createConnection(socketPath);

      const timeoutId = setTimeout(() => {
        // Connection timeout — server likely not listening
        try { client.destroy(); } catch { /* ignore */ }
        resolve(false);
      }, 1000);

      client.on('connect', () => {
        clearTimeout(timeoutId);
        try { client.destroy(); } catch { /* ignore */ }
        resolve(true);
      });

      client.on('error', () => {
        clearTimeout(timeoutId);
        try { client.destroy(); } catch { /* ignore */ }
        resolve(false);
      });
    });

    if (available) {
      logger.debug({ socketPath }, 'IPC availability check: available (connection probe succeeded)');
    } else {
      logger.debug({ socketPath, reason: 'probe_failed' }, 'IPC availability check: not available (connection probe failed)');
    }

    return available;
  } catch (error) {
    logger.debug({ socketPath, reason: 'exception', err: error }, 'IPC availability check: not available (probe exception)');
    return false;
  }
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
