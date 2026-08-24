/**
 * IPC utility functions for MCP tools.
 *
 * Shared utilities for transport availability checking and error message
 * generation.
 *
 * Issue #4280 (Phase 3, part 3): the transport is REST, unconditionally.
 * The Unix-socket availability probe and `getIpcSocketPath` discovery are
 * removed with it — `GET /api/ping` on the PrimaryNode HTTP API server is
 * the only liveness signal. `DISCLAUDE_REST_IPC_ENABLED` is no longer read:
 * it had no effect once REST became the only transport.
 *
 * @module mcp-server/tools/ipc-utils
 */

import { createLogger, RestIpcClient } from '@disclaude/core';

const logger = createLogger('IpcUtils');

/**
 * Resolve the PrimaryNode REST base URL from the standard env wiring.
 *
 * `DISCLAUDE_REST_IPC_BASE_URL` (default `http://localhost:9200`), with a
 * trailing slash stripped — shared by `getRestIpcClient` and the
 * `isIpcAvailable` probe so the two can't drift apart on env handling.
 * (`RestIpcClient`'s constructor also strips; that one stays as defense for
 * direct constructions elsewhere.)
 */
function resolveRestBaseUrl(): string {
  return (process.env.DISCLAUDE_REST_IPC_BASE_URL || 'http://localhost:9200').replace(/\/$/, '');
}

/**
 * Build a REST IPC client from the standard env wiring.
 *
 * - `DISCLAUDE_REST_IPC_BASE_URL` — PrimaryNode HTTP API server URL
 *   (default `http://localhost:9200`)
 * - `DISCLAUDE_REST_IPC_API_TOKEN` — bearer token for POST endpoints
 *   (must match the PrimaryNode `--api-token`)
 *
 * Issue #4280 (Phase 3, part 3): every MCP tool that previously reached for
 * the dual-path `getIpcClient()` facade (default Unix socket) constructs the
 * `RestIpcClient` directly here. No transport toggle remains.
 */
export function getRestIpcClient(): RestIpcClient {
  const baseUrl = resolveRestBaseUrl();
  const apiToken = process.env.DISCLAUDE_REST_IPC_API_TOKEN;
  return new RestIpcClient({ baseUrl, apiToken });
}

/**
 * Check if the PrimaryNode REST API is available for channel calls.
 *
 * Issue #1355: probe the real endpoint (`GET /api/ping`), not a file —
 * a socket file can disappear while the server still holds the fd, or
 * exist while nothing is listening. REST carries the same requirement:
 * only a 200 with `{ pong: true }` counts as available.
 *
 * Every MCP tool that gates on this (`send-card`, `interactive-message`,
 * `push-to-agent`, …) reports "IPC 服务不可用" when it returns false, so
 * the failure must be actionable on the REST wiring, not the socket path.
 *
 * @returns Promise resolving to true if the PrimaryNode REST API is reachable
 */
export async function isIpcAvailable(): Promise<boolean> {
  const baseUrl = resolveRestBaseUrl();
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

/**
 * Build the lark-cli fallback hint appended to IPC-unavailable errors.
 *
 * Issue #4576: when the PrimaryNode REST API is down, agents fall back to
 * `lark-cli im +messages-send` — which has no reply/thread flag, so in topic
 * groups the fallback reply "escapes" the thread and starts a new topic at
 * the group root. The actionable hint tells the agent to use
 * `+messages-reply` instead, which preserves thread attribution.
 *
 * @param parentMessageId - The message id the caller was asked to reply to,
 *   when known. Embedded in the hint so the agent has a concrete command;
 *   omitted (generic hint) when the send was not a thread reply.
 * @param options - Optional extras: `filePath` (send_file only) appends
 *   `--file <path>` to the suggested command — `+messages-reply` requires a
 *   content flag, so without it an agent copying the hint would send an empty
 *   reply. lark-cli only accepts cwd-relative paths, so pass the original
 *   `filePath` argument, not the workspace-resolved absolute path.
 * @returns The fallback hint string (empty-context callers append nothing).
 */
export function buildIpcFallbackHint(
  parentMessageId?: string,
  options?: { filePath?: string }
): string {
  const target = parentMessageId ?? '<om_...>';
  const fileFlag = options?.filePath ? ` --file ${options.filePath}` : '';
  return `IPC 不可用期间发送消息会丢失话题归属：lark-cli im +messages-send 没有 reply/thread 参数。请改用 \`lark-cli im +messages-reply --message-id ${target}${fileFlag}\` 回到原话题（Issue #4576），或等 PrimaryNode REST 恢复后重试。`;
}

/**
 * Generate user-facing error message based on IPC error type.
 * Issue #1088: Provide actionable error messages.
 * Issue #4280 (Phase 3, part 3): the service behind these errors is the
 * PrimaryNode REST API (`--api-port`, not a Unix socket), so the
 * unavailable case points at the REST startup requirement.
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
      return '❌ PrimaryNode REST 服务不可用。请检查主服务是否以 --api-port 启动，以及 DISCLAUDE_REST_IPC_BASE_URL 是否指向正确地址。';
    case 'ipc_timeout':
      return '❌ PrimaryNode 请求超时。服务可能过载，请稍后重试。';
    case 'ipc_request_failed':
      return `❌ PrimaryNode 请求失败: ${originalError ?? '未知错误'}`;
    default:
      return defaultMessage ?? `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }
}
