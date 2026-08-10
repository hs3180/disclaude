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
 * Issue #1042: Use the IPC socket path (legacy DISCLAUDE_WORKER_IPC_SOCKET name;
 *   Worker Node architecture removed in #2964) if available.
 * Issue #1355: Use actual connection probing instead of file-existence check.
 *   The socket file may disappear while the process still holds the fd,
 *   or the file may exist but the server is not listening.
 *
 * This function performs a file-existence check first (fast path),
 * then attempts an actual connection to verify the server is alive.
 *
 * @returns Promise resolving to true if IPC server is reachable
 *
 * Issue #4280 (Phase 3 prereq): when REST IPC is the configured transport
 * (`DISCLAUDE_REST_IPC_ENABLED=true`, selected in `getIpcClient` under #4279
 * Phase 2), probe the REST `/api/ping` endpoint instead of the Unix socket.
 * Without this branch every MCP tool that gates on `isIpcAvailable()`
 * (loop-start/status/stop, send-card, interactive-message, push-to-agent)
 * reports "IPC service unavailable" under REST mode, even though the REST
 * server is live. The Unix-socket probe below is the default transport and is
 * retained unchanged; removing it is the actual Phase 3 IPC deletion (#4280).
 */
export async function isIpcAvailable(): Promise<boolean> {
  if (process.env.DISCLAUDE_REST_IPC_ENABLED === 'true') {
    const baseUrl = (process.env.DISCLAUDE_REST_IPC_BASE_URL || 'http://localhost:9200').replace(/\/$/, '');
    try {
      const res = await fetch(`${baseUrl}/api/ping`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        logger.debug({ baseUrl, status: res.status, reason: 'rest_ping_not_ok' }, 'IPC availability check: REST ping non-OK');
        return false;
      }
      const json = (await res.json()) as { pong?: boolean };
      const available = json.pong === true;
      logger.debug({ baseUrl, available }, `IPC availability check: REST ${available ? 'available (ping ok)' : 'not available (no pong)'}`);
      return available;
    } catch (error) {
      logger.debug({ baseUrl, reason: 'rest_ping_exception', err: error }, 'IPC availability check: REST ping failed');
      return false;
    }
  }

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
