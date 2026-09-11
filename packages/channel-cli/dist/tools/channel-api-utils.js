/** Channel API client construction, availability checking, and actionable error messages. */
import { createLogger, normalizeChannelApiBaseUrl, ChannelApiClient } from "../../../core/dist/index.js";
const logger = createLogger('ChannelApiUtils');
/**
 * Resolve the PrimaryNode REST base URL from the standard env wiring.
 *
 * `DISCLAUDE_API_BASE_URL` (required), with a
 * trailing slash stripped — shared by `getChannelApiClient` and the
 * `isChannelApiAvailable` probe so the two can't drift apart on env handling.
 * (`ChannelApiClient`'s constructor also strips; that one stays as defense for
 * direct constructions elsewhere.)
 */
function resolveRestBaseUrl() {
    return normalizeChannelApiBaseUrl(process.env.DISCLAUDE_API_BASE_URL ?? '');
}
/**
 * Resolve the REST API token from the standard env wiring.
 *
 * `DISCLAUDE_API_TOKEN` — mirrors the PrimaryNode `--api-token`.
 * When the primary service runs with `--api-token`, every non-GET REST route
 * requires `Authorization: Bearer <token>` (http-api-server.ts). Issue #4801:
 * channel-cli previously never attached the header, so enabling the token made
 * all channel writes 401 while `GET /api/ping` (token-exempt) kept the
 * availability probe green. The token is read here and attached by
 * `getChannelApiClient` so send paths authenticate.
 */
function resolveRestApiToken() {
    const token = process.env.DISCLAUDE_API_TOKEN;
    return token && token.trim() ? token : undefined;
}
/**
 * Build a REST API client from the standard env wiring.
 *
 * - `DISCLAUDE_API_BASE_URL` — PrimaryNode HTTP API server URL
 *   (required for standalone clients; injected into managed children)
 * - `DISCLAUDE_API_TOKEN` — optional bearer token, forwarded to
 *   `ChannelApiClient` so authenticated writes succeed (Issue #4801).
 */
export function getChannelApiClient() {
    const baseUrl = resolveRestBaseUrl();
    return new ChannelApiClient({ baseUrl, apiToken: resolveRestApiToken() });
}
/**
 * Check if the PrimaryNode REST API is available for channel calls.
 *
 * Probe GET /api/ping:
 * only a 200 with `{ pong: true }` counts as available.
 *
 * Every channel tool that gates on this (`send-card`, `interactive-message`,
 * `push-to-agent`, …) reports "REST API 服务不可用" when it returns false, so
 * the failure must describe the required HTTP address and authentication.
 *
 * @returns Promise resolving to true if the PrimaryNode REST API is reachable
 */
export async function isChannelApiAvailable() {
    const baseUrl = resolveRestBaseUrl();
    const apiToken = resolveRestApiToken();
    try {
        // Issue #4801: attach the same token the real sends use, so the probe
        // never diverges from them on the wiring it exercises.
        //
        // Caveat — this does NOT fix the false-liveness case on its own:
        // `http-api-server.ts` exempts every GET from auth (`req.method !== 'GET'
        // && this.config.apiToken`), so `GET /api/ping` answers 200 even with a
        // wrong token, while POSTs 401. Detecting a misconfigured token needs a
        // non-GET probe (or a server-side change); until then this header is
        // forward-compatible only.
        const headers = {};
        if (apiToken) {
            headers.authorization = `Bearer ${apiToken}`;
        }
        const res = await fetch(`${baseUrl}/api/ping`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) {
            logger.debug({ baseUrl, status: res.status, reason: 'rest_ping_not_ok' }, 'REST API availability check: REST ping non-OK');
            return false;
        }
        const json = (await res.json());
        const available = json.pong === true;
        logger.debug({ baseUrl, available }, `REST API availability check: REST ${available ? 'available (ping ok)' : 'not available (no pong)'}`);
        return available;
    }
    catch (error) {
        logger.debug({ baseUrl, reason: 'rest_ping_exception', err: error }, 'REST API availability check: REST ping failed');
        return false;
    }
}
/**
 * Build the lark-cli fallback hint appended to REST API-unavailable errors.
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
export function buildChannelApiFallbackHint(parentMessageId, options) {
    const target = parentMessageId ?? '<om_...>';
    const fileFlag = options?.filePath ? ` --file ${options.filePath}` : '';
    return `REST API 不可用期间发送消息会丢失话题归属：lark-cli im +messages-send 没有 reply/thread 参数。请改用 \`lark-cli im +messages-reply --message-id ${target}${fileFlag}\` 回到原话题（Issue #4576），或等 PrimaryNode REST 恢复后重试。`;
}
/**
 * Generate user-facing error message based on REST API error type.
 * Issue #1088: Provide actionable error messages.
 * Issue #4280 (Phase 3, part 3): the service behind these errors is the
 * PrimaryNode REST API (`--api-port`), so the
 * unavailable case points at the REST startup requirement.
 *
 * @param errorType - The type of REST API error
 * @param originalError - The original error message
 * @param defaultMessage - Default message if no specific error type matches
 * @returns User-friendly error message
 */
export function getChannelApiErrorMessage(errorType, originalError, defaultMessage) {
    switch (errorType) {
        case 'channel_api_unavailable':
            return '❌ PrimaryNode REST 服务不可用。请检查主服务是否以 --api-port 启动，DISCLAUDE_API_BASE_URL 是否指向正确地址，且（若主服务启用了 --api-token）DISCLAUDE_API_TOKEN 是否一致。';
        case 'channel_api_timeout':
            return '❌ PrimaryNode 请求超时。服务可能过载，请稍后重试。';
        case 'channel_api_request_failed':
            return `❌ PrimaryNode 请求失败: ${originalError ?? '未知错误'}`;
        default:
            return defaultMessage ?? `❌ 操作失败: ${originalError ?? '未知错误'}`;
    }
}
