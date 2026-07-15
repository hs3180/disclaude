/**
 * RestIpcClient — HTTP client for the REST IPC face (Issue #4279 Phase 2).
 *
 * A standalone client that calls the REST endpoints exposed by HttpApiServer
 * (primary-node), providing REST parity with the IPC channel methods. This is
 * Phase 2 part 1: the channel-method surface (ping/sendMessage/sendCard/
 * uploadFile/uploadImage/sendInteractive/listTempChats/markChatResponded).
 *
 * The full IpcClientLike drop-in (adding pushToAgent → /api/push and loop
 * methods → /api/loop/* with their distinct response shapes) is a follow-up —
 * the mcp-server currently calls those via the Unix-socket IPC client.
 *
 * Routing is table-driven and response shaping is a generic strip-`ok` envelope
 * (REST responses are `{ ok: true, ...IpcResponsePayload }`; IPC payloads are
 * just the inner fields).
 *
 * Decision-3-independent: `apiToken` is a constructor param; the *source*
 * (env/file/injection) is decided by the wiring step, not here.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('RestIpcClient');

/** Default request timeout (30s), matching the IPC client default. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default response shape: strip the `ok` REST envelope (REST responses are
 * `{ ok: true, ...IpcResponsePayload }`; IPC payloads are just the inner fields).
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
  /** Dynamic path builder (e.g. for path-param routes like loopStatus). */
  pathBuilder?: (payload: Record<string, unknown>) => string;
  /** Per-route response shaping (default: strip `ok`). */
  shape?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Route table: IPC method → REST endpoint. Covers all 12 IPC methods:
 * - 8 channel methods + ping → #4279 Phase 1 endpoints (strip-ok shaping).
 * - pushToAgent → /api/push (REST {ok,message} → IPC {success}).
 * - loopStart/loopStop/loopStatus → /api/loop/* (REST shapes adapted to IPC).
 */
const ROUTES: Readonly<Record<string, Route>> = {
  // Channel methods (Issue #4279 Phase 1 endpoints)
  ping: { method: 'GET', path: '/api/ping' },
  sendMessage: { method: 'POST', path: '/api/send-message' },
  sendCard: { method: 'POST', path: '/api/send-card' },
  uploadFile: { method: 'POST', path: '/api/upload-file' },
  uploadImage: { method: 'POST', path: '/api/upload-image' },
  sendInteractive: { method: 'POST', path: '/api/send-interactive' },
  listTempChats: { method: 'GET', path: '/api/temp-chats' },
  markChatResponded: { method: 'POST', path: '/api/mark-chat-responded' },
  // pushToAgent → /api/push (REST returns {ok, message}; IPC expects {success})
  pushToAgent: { method: 'POST', path: '/api/push', shape: (b) => ({ success: b.ok === true }) },
  // Loop Runner → /api/loop/* (REST shapes adapted to IPC payloads)
  loopStart: {
    method: 'POST', path: '/api/loop/start',
    shape: (b) => ({ success: b.ok === true, ...(b.loopId ? { loopId: b.loopId } : {}) }),
  },
  loopStop: { method: 'POST', path: '/api/loop/stop', shape: (b) => ({ success: b.ok === true }) },
  loopStatus: {
    method: 'GET',
    pathBuilder: (p) => `/api/loop/status/${p.loopId}`,
    shape: (b) => ({ success: b.ok === true, ...(b.status ? { status: b.status } : {}) }),
  },
};

export interface RestIpcClientOptions {
  /** Base URL of the HttpApiServer (e.g. http://localhost:9200). */
  baseUrl: string;
  /** Optional bearer token for POST endpoints (GET routes are token-exempt). */
  apiToken?: string;
}

export class RestIpcClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;

  constructor(opts: RestIpcClientOptions) {
    // Strip trailing slash for clean URL concatenation.
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiToken = opts.apiToken;
  }

  /**
   * Send a channel-method request via REST. Returns the IPC response payload
   * (the REST `{ ok, ...payload }` body with the `ok` envelope stripped).
   *
   * @param type - One of the CHANNEL_ROUTES keys (ping/sendMessage/...).
   * @param payload - The IPC request payload (sent as the JSON body for POST).
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
      throw new Error(`RestIpcClient: unsupported method '${type}'`);
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

    logger.debug({ type, url, method: route.method }, 'RestIpcClient request');

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`REST_${type}_FAILED: ${msg}`);
    }

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`REST_${type}_FAILED: invalid JSON response (status ${res.status})`);
    }

    if (!res.ok || json.ok !== true) {
      const msg = (json.message as string | undefined) ?? `${type} failed (HTTP ${res.status})`;
      throw new Error(`REST_${type}_FAILED: ${msg}`);
    }

    // Apply per-route response shaping (default: strip the `ok` envelope).
    return (route.shape ?? stripOk)(json);
  }

  /**
   * Health probe: GET /api/ping. Returns true if the server responds with
   * `{ pong: true }`. This is the REST equivalent of the IPC `isAvailable()`
   * socket probe (#4279 Phase 2).
   */
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
      logger.debug({ err }, 'RestIpcClient health probe failed');
      return false;
    }
  }

  /** No persistent resources to close (stateless HTTP). */
  close(): void {
    // No-op — HTTP is stateless, unlike the Unix-socket IPC client.
  }
}
