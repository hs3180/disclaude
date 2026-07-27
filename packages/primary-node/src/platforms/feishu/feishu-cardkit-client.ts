/**
 * Feishu Card Kit raw-HTTP client.
 *
 * Issue #4395 (#4208 P1-a): the installed @larksuiteoapi/node-sdk has NO Card
 * Kit client (verified in #4238), so native streaming (typewriter + breathing
 * cursor via JSON-2.0 `config.streaming_mode`) requires direct HTTP calls.
 *
 * Endpoints (confirmed by #4238 research, authoritative):
 *   PATCH /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content
 *     — typewriter streaming: incremental element content.
 *   PATCH /open-apis/cardkit/v1/cards/{card_id}
 *     — finalize: write the final card / drop the streaming marker.
 *
 * Auth: tenant_access_token sent as `Bearer`. disclaude's existing Feishu
 * plumbing carries it in `process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN`
 * (see feishu-channel.ts); `createCardKitClientFromEnv()` reuses that.
 *
 * Scope (this file = #4395 part 1): the PATCH operations. `createCard` (obtain
 * a card_id) is deferred to part 2 — the create endpoint was not confirmed by
 * #4238 and the card_id may come from the message-send path rather than a
 * dedicated Card Kit create call; callers obtain a card_id by other means for
 * now. Nothing in disclaude wires this client yet (pure infrastructure).
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('FeishuCardKitClient');

/** Default Feishu open-platform base URL (lark.Domain.Feishu). */
export const DEFAULT_CARDKIT_BASE_URL = 'https://open.feishu.cn';

/** Card Kit API path prefix. */
const CARDKIT_PATH = '/open-apis/cardkit/v1';

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
}

/**
 * Raw-HTTP Card Kit client. Two PATCH operations for native streaming.
 *
 * @see #4395, #4238, #4208
 */
export class FeishuCardKitClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

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
  }

  /**
   * PATCH a single element's content (typewriter streaming).
   * `PATCH /cardkit/v1/cards/{card_id}/elements/{element_id}/content`.
   *
   * @param cardId - the streaming card id
   * @param elementId - stable element id (e.g. STREAMING_REPLY_ELEMENT_ID from #4396)
   * @param content - new content for the element (replace-semantics)
   */
  patchElementContent(
    cardId: string,
    elementId: string,
    content: string,
  ): Promise<CardKitPatchResult> {
    return this.patch(
      `/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
      { content },
    );
  }

  /**
   * PATCH the whole card (finalize / drop streaming marker).
   * `PATCH /cardkit/v1/cards/{card_id}`.
   *
   * @param cardId - the streaming card id
   * @param body - the final card body (JSON-2.0); caller owns the shape
   */
  patchCard(cardId: string, body: unknown): Promise<CardKitPatchResult> {
    return this.patch(`/cards/${encodeURIComponent(cardId)}`, body);
  }

  /** Core PATCH with Bearer auth + 401/non-2xx handling. */
  private async patch(path: string, body: unknown): Promise<CardKitPatchResult> {
    const url = `${this.baseUrl}${CARDKIT_PATH}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      // Token expired or invalid — surface a clear, actionable error so the
      // caller can refresh LARKSUITE_CLI_TENANT_ACCESS_TOKEN and retry.
      throw new CardKitClientError(
        'Card Kit API rejected tenant_access_token (401 Unauthorized). Refresh LARKSUITE_CLI_TENANT_ACCESS_TOKEN.',
        401,
      );
    }

    if (!res.ok) {
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text().catch(() => undefined);
      }
      throw new CardKitClientError(
        `Card Kit PATCH ${path} failed: HTTP ${res.status}`,
        res.status,
        responseBody,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined; // empty/204 body
    }
    return { ok: true, status: res.status, data };
  }
}

export interface CardKitPatchResult {
  ok: true;
  status: number;
  /** Parsed JSON response body when present. */
  data?: unknown;
}

/**
 * Build a FeishuCardKitClient from the standard env var
 * (`LARKSUITE_CLI_TENANT_ACCESS_TOKEN`), the same source feishu-channel uses.
 *
 * @throws if the env var is unset (caller must surface a clear message).
 */
export function createCardKitClientFromEnv(
  options?: Omit<CardKitClientOptions, 'tenantAccessToken'>,
): FeishuCardKitClient {
  const tenantAccessToken = process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN || '';
  if (!tenantAccessToken) {
    logger.warn(
      'LARKSUITE_CLI_TENANT_ACCESS_TOKEN is not set — Card Kit streaming will fail with 401.',
    );
  }
  return new FeishuCardKitClient({ ...(options || {}), tenantAccessToken });
}
