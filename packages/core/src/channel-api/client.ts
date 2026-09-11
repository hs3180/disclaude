/** HTTP client for DisclaudeService channel endpoints. Requires an explicit base URL and uses an optional bearer token for authenticated requests. */

import { createLogger } from '../utils/logger.js';
import type { ChannelApiRequestType, ChannelApiRequestPayloads, ChannelApiResponsePayloads } from './protocol.js';
import {
  type ChannelApiClientLike,
} from './client-methods.js';

const logger = createLogger('ChannelApiClient');

/**
 * Validate the explicit DisclaudeService REST address shared by all clients.
 * Credentials are deliberately rejected in URLs so diagnostics and debug logs
 * cannot disclose them; bearer authentication uses the separate token option.
 */
export function normalizeChannelApiBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error(
      'DisclaudeService REST address is required; pass --base-url or set DISCLAUDE_API_BASE_URL',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid DisclaudeService REST address: ${JSON.stringify(raw)}`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('DisclaudeService REST address must be an absolute http(s) URL without credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DisclaudeService REST address must not include a path, query, or fragment');
  }
  return url.origin;
}

/** Default request timeout (30s), matching the REST API client default. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default response shape: strip the `ok` REST envelope (REST responses are
 * `{ ok: true, ...ChannelApiResponsePayload }`; REST API payloads are just the inner fields).
 */
const stripOk = (body: Record<string, unknown>): Record<string, unknown> => {
  const { ok: _ok, ...rest } = body;
  return rest;
};

/** A route entry: REST endpoint + optional dynamic-path builder + response shaping. */
interface Route {
  method: 'GET' | 'POST';
  /** Static path (e.g. `/api/send-message`). */
  path?: string;
  /** Dynamic path builder (e.g. for path-param routes). */
  pathBuilder?: (payload: Record<string, unknown>) => string;
  /**
   * Per-route success predicate (default: `res.ok && json.ok === true`).
   * Routes whose endpoint returns a non-`{ ok }` envelope override this —
   * e.g. `/api/ping` returns `{ pong: true }` (no `ok`), so its success is
   * `res.ok && json.pong === true`. Without this, ping would always throw
   * because the default guard demands `json.ok === true`.
   */
  success?: (json: Record<string, unknown>, res: Response) => boolean;
  /** Per-route response shaping (default: strip `ok`). */
  shape?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/** Default success: HTTP ok AND the REST `{ ok: true }` envelope. */
const defaultSuccess = (json: Record<string, unknown>, res: Response): boolean =>
  res.ok && json.ok === true;

/**
 * Route table: REST API method → REST endpoint. Covers the 9 REST API methods:
 * - 8 channel methods + ping → #4279 Phase 1 endpoints (strip-ok shaping).
 * - pushToAgent → /api/push (REST {ok,message} → REST API {success}).
 */
const ROUTES: Readonly<Record<string, Route>> = {
  // Channel methods (Issue #4279 Phase 1 endpoints). 8/9 routes are on `main`:
  // ping/sendMessage/sendCard/uploadFile/uploadImage/sendInteractive/tempChats
  // (PRs #4341/#4343/#4344/#4347/#4346/#4345/#4348) and markChatResponded
  // (Issue #4281 — port of the closed-unmerged PR #4342 blueprint).
  // ping returns `{ pong: true }` (no `ok` envelope) — see handlePing server-side.
  ping: { method: 'GET', path: '/api/ping', success: (json, res) => res.ok && json.pong === true },
  sendMessage: { method: 'POST', path: '/api/send-message' },
  sendCard: { method: 'POST', path: '/api/send-card' },
  requestPrivateInput: { method: 'POST', path: '/api/private-workflows' },
  uploadFile: { method: 'POST', path: '/api/upload-file' },
  uploadImage: { method: 'POST', path: '/api/upload-image' },
  sendInteractive: { method: 'POST', path: '/api/send-interactive' },
  listTempChats: { method: 'GET', path: '/api/temp-chats' },
  markChatResponded: { method: 'POST', path: '/api/mark-chat-responded' },
  // pushToAgent → /api/push (REST returns {ok, message}; REST API expects {success})
  pushToAgent: { method: 'POST', path: '/api/push', shape: (b) => ({ success: b.ok === true }) },
};

export interface ChannelApiClientOptions {
  /** Explicit base URL of the HttpApiServer (e.g. http://127.0.0.1:43123). */
  baseUrl: string;
  /** Optional bearer token for POST endpoints (GET routes are token-exempt). */
  apiToken?: string;
}

export class ChannelApiClient implements ChannelApiClientLike {
  private readonly baseUrl: string;
  private readonly apiToken?: string;

  constructor(opts: ChannelApiClientOptions) {
    this.baseUrl = normalizeChannelApiBaseUrl(opts.baseUrl);
    this.apiToken = opts.apiToken;
  }

  /**
   * Send a channel-method request via REST. Returns the REST API response payload
   * (the REST `{ ok, ...payload }` body with the `ok` envelope stripped).
   *
   * @param type - One of the CHANNEL_ROUTES keys (ping/sendMessage/...).
   * @param payload - The REST API request payload (sent as the JSON body for POST).
   * @param options - Optional timeoutMs.
   * @returns The response payload (e.g. `{ success: true, messageId: '...' }`).
   */
  async requestChannel(
    type: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const route = ROUTES[type];
    if (!route) {
      throw new Error(`ChannelApiClient: unsupported method '${type}'`);
    }

    const path = route.pathBuilder ? route.pathBuilder(payload ?? {}) : (route.path ?? '');
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    const init: RequestInit = { method: route.method, headers };

    if (route.method === 'POST') {
      headers['content-type'] = 'application/json';
      if (this.apiToken) {
        headers.authorization = `Bearer ${this.apiToken}`;
      }
      init.body = JSON.stringify(payload ?? {});
    }

    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    logger.debug({ type, url, method: route.method }, 'ChannelApiClient request');

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Map REST transport failures onto the REST API error-prefix contract so the
      // shared `classifyError` (client-methods) tags them correctly:
      //   timeout        → CHANNEL_API_TIMEOUT        (→ "请求超时，稍后重试")
      //   conn refused…  → CHANNEL_API_NOT_AVAILABLE  (→ "disclaude service 未运行")
      // The method name is preserved in the message for debuggability.
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      const code = isTimeout ? 'CHANNEL_API_TIMEOUT' : 'CHANNEL_API_NOT_AVAILABLE';
      throw new Error(`${code}: REST ${type} (${msg})`);
    }

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`CHANNEL_API_REQUEST_FAILED: REST ${type} (invalid JSON response, status ${res.status})`);
    }

    if (!(route.success ?? defaultSuccess)(json, res)) {
      const msg = (json.message as string | undefined) ?? `${type} failed (HTTP ${res.status})`;
      throw new Error(`CHANNEL_API_REQUEST_FAILED: REST ${type} (${msg})`);
    }

    // Apply per-route response shaping (default: strip the `ok` envelope).
    return (route.shape ?? stripOk)(json);
  }

  /** Send a typed request to a channel endpoint. */
  async request<T extends ChannelApiRequestType>(
    type: T,
    payload: ChannelApiRequestPayloads[T],
    options?: { timeoutMs?: number },
  ): Promise<ChannelApiResponsePayloads[T]> {
    return await this.requestChannel(
      type,
      payload as Record<string, unknown>,
      options,
    ) as ChannelApiResponsePayloads[T];
  }

  /** Probe HTTP liveness with GET /api/ping; this does not verify POST authorization. */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ping`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) { return false; }
      const json = (await res.json()) as { pong?: boolean };
      return json.pong === true;
    } catch (err) {
      logger.debug({ err }, 'ChannelApiClient health probe failed');
      return false;
    }
  }

}
