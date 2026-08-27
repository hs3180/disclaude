/**
 * Feishu Card Kit raw-HTTP client.
 *
 * Issue #4395 (#4208 P1-a): the installed @larksuiteoapi/node-sdk has NO Card
 * Kit client, so native streaming (typewriter + breathing cursor via JSON-2.0
 * `config.streaming_mode`) requires direct HTTP calls.
 *
 * Endpoints (verified against the live Feishu API 2026-07-28; the earlier
 * "#4238 says PATCH" claim was wrong — PATCH 404s, the real method is PUT):
 *   POST  /open-apis/cardkit/v1/cards
 *           — create a card, obtain a `card_id` (#4395 part 2).
 *             Body: { type: 'card_json', data: <stringified card> }.
 *             (Create has no uuid/sequence — those belong to the update ops.)
 *             Decision #4208 (2026-08-03) settled this create path.
 *   PUT   /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content
 *           — typewriter streaming: incremental element content.
 *             Body: { content, sequence, uuid }.
 *   PUT   /open-apis/cardkit/v1/cards/{card_id}
 *           — write/replace the full card (e.g. append buttons after streaming).
 *             Body: { card: { type: 'card_json', data: <stringified card> }, sequence, uuid }.
 *   PATCH /open-apis/cardkit/v1/cards/{card_id}/settings
 *           — finalize: turn off the breathing cursor (streaming_mode = false).
 *             Body: { settings: <stringified settings>, sequence, uuid }.
 *
 * `sequence` is a single per-card counter that increments across ALL operations
 * (PUT content, PUT card, PATCH settings share it); out-of-order/reused values
 * are rejected with business code 300317. The client is stateless — the caller
 * (streaming state machine #4399) owns the counter and passes it in.
 *
 * Auth: tenant_access_token sent as `Bearer`. disclaude's existing Feishu
 * plumbing carries it in `process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN`
 * (see feishu-channel.ts); `createCardKitClientFromEnv()` reuses that.
 *
 * Scope (this file = #4395 parts 1 + 2): the create + update/finalize
 * operations. `createCard` (part 2) was deferred from #4411 until the create
 * path was settled — decision #4208 (2026-08-03) settled it on Card Kit native
 * POST /cards. The message-send step that makes a created card appear in a
 * conversation is wiring (ChatAgent / #4399 / #4400), NOT this client — but
 * see `createCard()` JSDoc for the IM delivery format pitfall (card_json
 * envelope vs {type:'card',data:{card_id}}). Nothing in disclaude wires
 * this client yet (pure infrastructure).
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('FeishuCardKitClient');

/** Default Feishu open-platform base URL (lark.Domain.Feishu). */
export const DEFAULT_CARDKIT_BASE_URL = 'https://open.feishu.cn';

/** Card Kit API path prefix. */
const CARDKIT_PATH = '/open-apis/cardkit/v1';

/** Default per-request timeout in ms (mirrors wechat/api-client.ts). */
const DEFAULT_CARDKIT_TIMEOUT_MS = 15_000;

/**
 * Parse raw response text as JSON, falling back to the raw text (or undefined
 * when empty). Reading the body once as text and parsing it ourselves avoids
 * the double-consume bug of calling `.json()` then `.text()` on one Response.
 */
function safeParseJson(raw: string | undefined): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Generate a request uuid (Card Kit echoes it for idempotency debugging). */
function randomUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Error thrown for non-2xx Card Kit responses (incl. 401 token failure). */
export class CardKitClientError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Parsed response body when available (for debugging). */
  readonly responseBody?: unknown;

  constructor(message: string, status: number, responseBody?: unknown) {
    super(message);
    this.name = 'CardKitClientError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export interface CardKitClientOptions {
  /** tenant_access_token (sent as Bearer). Required. */
  tenantAccessToken: string;
  /** Override base URL (default open.feishu.cn; useful for Lark / tests). */
  baseUrl?: string;
  /** Inject fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 15000). Guards against hung streams. */
  timeoutMs?: number;
  /** External AbortSignal; aborting it cancels any in-flight request. */
  signal?: AbortSignal;
}

/**
 * Raw-HTTP Card Kit client. PUT/PATCH operations for native streaming,
 * verified against the live Feishu API.
 *
 * @see #4395, #4411, #4208
 */
export class FeishuCardKitClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(options: CardKitClientOptions) {
    if (!options || !options.tenantAccessToken) {
      throw new Error('FeishuCardKitClient: options.tenantAccessToken is required');
    }
    this.token = options.tenantAccessToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_CARDKIT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('FeishuCardKitClient: no global fetch available — pass options.fetchImpl');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CARDKIT_TIMEOUT_MS;
    this.signal = options.signal;
  }

  /**
   * Create a streaming card and obtain its `card_id` (#4395 part 2).
   * `POST /cardkit/v1/cards`.
   *
   * The card is sent as `{ type: 'card_json', data: <stringified card> }` — the
   * same envelope `updateCard` uses. The response's `data.card_id` is the
   * handle every subsequent PUT/PATCH operation targets (callers pass it to
   * `updateElementContent` / `updateCard` / `finalizeStreaming`). Decision #4208
   * (2026-08-03) settled the create path: Card Kit native POST /cards with
   * `type: card_json`, then a separate message-send step makes the card appear
   * in a conversation — that send is wiring (ChatAgent / #4399 / #4400), out of
   * scope for this pure-infrastructure client.
   *
   * ⚠️ That message-send step has a NON-obvious format (verified live
   * 2026-08-26): IM delivery of an already-created card must use
   * `POST im/v1/messages` with `msg_type: 'interactive'` and content
   * `{ type: 'card', data: { card_id: <id> } }` (stringified). Reusing the
   * Card Kit `card_json` envelope here (the natural guess after reading the
   * endpoints above) fails with business codes 230099 / 200621. See the
   * step-2 IM send in FeishuChannel.startStreaming for the working call.
   *
   * @param card - the JSON-2.0 card object (e.g. buildStreamingPlaceholderCard()
   *               from #4396); serialized into `{type:'card_json', data}`
   * @returns the created card's id + the parsed response body
   */
  async createCard(card: unknown): Promise<CardKitCreateResult> {
    // Create has no uuid/sequence (those are update-op fields, verified against
    // the Feishu create-card doc — POST /cards body is {type, data} only).
    const result = await this.request('POST', '/cards', {
      type: 'card_json',
      data: JSON.stringify(card),
    });
    const cardId = extractCardId(result.data);
    return { ...result, cardId };
  }

  /**
   * PUT a single element's content (typewriter streaming).
   * `PUT /cardkit/v1/cards/{card_id}/elements/{element_id}/content`.
   *
   * @param cardId - the streaming card id
   * @param elementId - stable element id (e.g. STREAMING_REPLY_ELEMENT_ID from #4396)
   * @param content - new content for the element (replace-semantics; old text
   *                  should be a prefix of new text for the typewriter effect)
   * @param sequence - per-card monotonic counter (shared across all operations)
   * @param uuid - optional request id; generated if omitted
   */
  updateElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    uuid?: string
  ): Promise<CardKitResult> {
    return this.request(
      'PUT',
      `/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
      { content, sequence, uuid: uuid ?? randomUuid() }
    );
  }

  /**
   * PUT the whole card (replace / append elements, e.g. add buttons after the
   * stream finishes).
   * `PUT /cardkit/v1/cards/{card_id}`.
   *
   * @param cardId - the streaming card id
   * @param card - the JSON-2.0 card object; serialized into `{card:{type,data}}`
   * @param sequence - per-card monotonic counter (shared across all operations)
   * @param uuid - optional request id; generated if omitted
   */
  updateCard(
    cardId: string,
    card: unknown,
    sequence: number,
    uuid?: string
  ): Promise<CardKitResult> {
    return this.request('PUT', `/cards/${encodeURIComponent(cardId)}`, {
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
      uuid: uuid ?? randomUuid(),
    });
  }

  /**
   * Finalize streaming: turn the breathing cursor off (streaming_mode = false).
   * `PATCH /cardkit/v1/cards/{card_id}/settings`.
   *
   * (This is the one Card Kit settings operation that genuinely uses PATCH —
   * verified live. The content/card updates above are PUT.)
   *
   * @param cardId - the streaming card id
   * @param sequence - per-card monotonic counter (shared across all operations)
   * @param uuid - optional request id; generated if omitted
   * @param settings - optional settings object; defaults to streaming_mode off
   */
  finalizeStreaming(
    cardId: string,
    sequence: number,
    uuid?: string,
    settings: Record<string, unknown> = { config: { streaming_mode: false } }
  ): Promise<CardKitResult> {
    return this.request('PATCH', `/cards/${encodeURIComponent(cardId)}/settings`, {
      settings: JSON.stringify(settings),
      sequence,
      uuid: uuid ?? randomUuid(),
    });
  }

  /**
   * Core request with Bearer auth, timeout, and Feishu business-code handling.
   *
   * Feishu's error model is HTTP 200 + body `{ code: <non-zero>, msg }`: a bare
   * `res.ok` check would silently swallow token/param/permission/rate-limit
   * failures as `{ ok: true }`, so we parse the body and check `code` (mirrors
   * the `ret !== 0` check in wechat/api-client.ts).
   */
  private async request(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    body: unknown
  ): Promise<CardKitResult> {
    const url = `${this.baseUrl}${CARDKIT_PATH}${path}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Let a caller-initiated cancel also abort the in-flight request. We remove
    // this listener ourselves when the request ends (see `finally` below):
    // `{ once: true }` only self-removes when the signal actually fires, so on a
    // long-lived client issuing many requests against a single external signal
    // it would otherwise accumulate past the AbortSignal default listener cap
    // (10) and emit a MaxListenersExceededWarning on every request past the 10th.
    const externalSignal = this.signal;
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);

    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Read the body ONCE as text then parse — `.json()` followed by `.text()`
      // on the same Response consumes the stream twice (the second read is empty).
      const parsed = safeParseJson(await res.text().catch(() => undefined));

      if (res.status === 401) {
        // Token expired/invalid — surface a clear, actionable error so the
        // caller can refresh LARKSUITE_CLI_TENANT_ACCESS_TOKEN and retry.
        throw new CardKitClientError(
          'Card Kit API rejected tenant_access_token (401 Unauthorized). Refresh LARKSUITE_CLI_TENANT_ACCESS_TOKEN.',
          401,
          parsed
        );
      }

      if (!res.ok) {
        throw new CardKitClientError(
          `Card Kit ${method} ${path} failed: HTTP ${res.status}`,
          res.status,
          parsed
        );
      }

      // Feishu business error: HTTP 200 + `code !== 0` (e.g. 99991663 invalid
      // token, 300317 bad sequence, permission denied, rate-limit). Without this
      // guard such failures are reported to callers as `{ ok: true }`.
      const bodyObj = parsed as { code?: unknown; msg?: unknown; message?: unknown } | undefined;
      const code = bodyObj?.code;
      if (typeof code === 'number' && code !== 0) {
        const msg = bodyObj?.msg ?? bodyObj?.message ?? `code ${code}`;
        logger.error({ path, code, msg }, 'Card Kit API returned a business error');
        throw new CardKitClientError(
          `Card Kit ${method} ${path} failed: business code ${code} (${msg})`,
          res.status,
          parsed
        );
      }

      return { ok: true, status: res.status, data: parsed };
    } catch (err) {
      // Typed errors (401 / non-2xx / business code) already carry status +
      // body — pass them through unchanged so the caller sees the real status
      // and the original response body.
      if (err instanceof CardKitClientError) {
        throw err;
      }
      // Timeout or external cancel — fetch rejects with an AbortError.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CardKitClientError(
          `Card Kit ${method} ${path} aborted (timed out after ${this.timeoutMs}ms or cancelled)`,
          0
        );
      }
      // Network-layer failures (e.g. `TypeError: fetch failed`, DNS, connection
      // reset) — wrap so callers can catch ALL client errors uniformly via
      // `instanceof CardKitClientError` instead of handling bare fetch errors
      // with no status/body. status 0 = no HTTP response was received.
      throw new CardKitClientError(
        `Card Kit ${method} ${path} request failed: ${err instanceof Error ? err.message : String(err)}`,
        0
      );
    } finally {
      // Always release the timer and the external-signal listener, whether the
      // request succeeded, threw, or was aborted. (Nit fix: previously the
      // {once:true} listener leaked on every non-aborting request, eventually
      // tripping the AbortSignal 10-listener cap on long-lived clients.)
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

export interface CardKitResult {
  ok: true;
  status: number;
  /** Parsed JSON response body when present. */
  data?: unknown;
}

/**
 * Result of `createCard`. Extends {@link CardKitResult} with the created card's
 * id, extracted from the Feishu response (`data.card_id`) when present.
 */
export interface CardKitCreateResult extends CardKitResult {
  /**
   * The created card's id, or `undefined` if the response did not carry one.
   * Feishu returns `{ code: 0, data: { card_id } }`; a missing id on a 2xx /
   * code-0 response is unexpected but non-fatal — callers should treat it as a
   * protocol mismatch rather than proceed to PUT/PATCH a phantom handle.
   */
  cardId?: string;
}

/**
 * Pull `card_id` out of a Card Kit create response.
 *
 * Feishu wraps payload data one level deep: `{ code, msg, data: { card_id } }`.
 * We tolerate a couple of shapes (top-level `card_id`, or `data.card_id`) so a
 * harmless envelope change doesn't break callers, but return `undefined`
 * rather than guessing when neither is present.
 */
function extractCardId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const obj = body as { card_id?: unknown; data?: { card_id?: unknown } };
  const direct = typeof obj.card_id === 'string' ? obj.card_id : undefined;
  if (direct) {
    return direct;
  }
  const nested = obj.data && typeof obj.data.card_id === 'string' ? obj.data.card_id : undefined;
  return nested;
}

/**
 * Build a FeishuCardKitClient from the standard env var
 * (`LARKSUITE_CLI_TENANT_ACCESS_TOKEN`), the same source feishu-channel uses.
 *
 * @throws if the env var is unset (caller must surface a clear message).
 */
export function createCardKitClientFromEnv(
  options?: Omit<CardKitClientOptions, 'tenantAccessToken'>
): FeishuCardKitClient {
  const tenantAccessToken = process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN;
  if (!tenantAccessToken) {
    throw new Error(
      'createCardKitClientFromEnv: LARKSUITE_CLI_TENANT_ACCESS_TOKEN is not set — Card Kit streaming cannot authenticate. Export it before constructing the client.'
    );
  }
  return new FeishuCardKitClient({ ...(options || {}), tenantAccessToken });
}
