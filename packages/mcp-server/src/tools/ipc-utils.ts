/**
 * IPC utility functions for MCP tools.
 *
 * Shared utilities for IPC availability checking and error message generation.
 *
 * @module mcp-server/tools/ipc-utils
 */

import { existsSync } from 'fs';
import { createConnection } from 'net';
import { getIpcSocketPath, getIpcClient, RestIpcClient, createLogger } from '@disclaude/core';

const logger = createLogger('IpcUtils');

/**
 * Check if IPC is available for Feishu API calls.
 * Issue #1035: Prefer IPC when available for unified client management.
 * Issue #1042: Use the IPC socket path (legacy DISCLAUDE_WORKER_IPC_SOCKET name;
 *   Worker Node architecture removed in #2964) if available.
 * Issue #1355: Use actual connection probing instead of file-existence check.
 *   The socket file may disappear while the process still holds the fd,
 *   or the file may exist but the server is not listening.
 * Issue #4168 (REST IPC prep): When `DISCLAUDE_REST_IPC_ENABLED=true` (#4279
 *   Phase 2) there is no Unix socket — this check must delegate to the REST
 *   client's `GET /api/ping` health probe instead of stat'ing a socket that
 *   doesn't exist. Without this, every MCP tool that gates on
 *   `isIpcAvailable()` (loop-start/stop/status, push-to-agent,
 *   interactive-message, send-message, send-card, send-file) refuses to run
 *   under the REST transport, blocking the flag flip documented in #4168's
 *   migration-status comment (gap #1).
 *
 * For the Unix-socket transport this function performs a file-existence check
 * first (fast path), then attempts an actual connection to verify the server
 * is alive.
 *
 * @returns Promise resolving to true if the IPC server is reachable
 */
export async function isIpcAvailable(): Promise<boolean> {
  // REST IPC transport (#4279 Phase 2): no Unix socket exists, so the socket
  // probe below would always report unavailable. Delegate to the active REST
  // client's health probe (GET /api/ping → { pong: true }). Transport selection
  // uses the same env var in `getIpcClient()`, so under REST mode the returned
  // client is always a `RestIpcClient`.
  if (process.env.DISCLAUDE_REST_IPC_ENABLED === 'true') {
    const client = getIpcClient();
    if (client instanceof RestIpcClient) {
      try {
        const available = await client.isAvailable();
        logger.debug(
          { available, reason: available ? 'rest_ping_ok' : 'rest_ping_fail' },
          'IPC availability check (REST transport)',
        );
        return available;
      } catch (error) {
        logger.debug(
          { reason: 'rest_ping_exception', err: error },
          'IPC availability check: not available (REST probe exception)',
        );
        return false;
      }
    }
    logger.debug(
      { reason: 'rest_mode_client_mismatch' },
      'IPC availability check: REST mode enabled but client is not a RestIpcClient',
    );
    return false;
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
