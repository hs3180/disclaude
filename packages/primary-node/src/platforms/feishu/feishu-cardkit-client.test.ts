/**
 * Tests for the Feishu Card Kit raw-HTTP client (Issue #4395 / #4238).
 *
 * Mocks global.fetch (the repo's established pattern, cf. wechat api-client
 * tests) — no live Feishu calls. Asserts the request shape (URL, method,
 * Bearer auth, JSON body) and the 401/non-2xx handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FeishuCardKitClient,
  createCardKitClientFromEnv,
  DEFAULT_CARDKIT_BASE_URL,
} from './feishu-cardkit-client.js';

const CARD_ID = 'card_abc';
const ELEMENT_ID = 'streaming_reply_region';

/** Build a fake fetch Response. */
function fakeResponse(status: number, body: unknown = {}): Response {
  const json = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(JSON.parse(json)),
    text: () => Promise.resolve(json),
  } as unknown as Response;
}

describe('FeishuCardKitClient (Issue #4395)', () => {
  let calls: { url: string; init: RequestInit }[];
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    mockFetch = vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(fakeResponse(200, { code: 0, msg: 'ok' }));
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeClient() {
    return new FeishuCardKitClient({
      tenantAccessToken: 'tn-token-xyz',
      fetchImpl: mockFetch,
    });
  }

  describe('patchElementContent (typewriter streaming)', () => {
    it('PATCHes the element content endpoint with Bearer auth + JSON body', async () => {
      const client = makeClient();
      await client.patchElementContent(CARD_ID, ELEMENT_ID, 'incremental text');

      expect(calls).toHaveLength(1);
      const [{ url, init }] = calls;
      expect(url).toBe(
        `${DEFAULT_CARDKIT_BASE_URL}/open-apis/cardkit/v1/cards/${CARD_ID}/elements/${ELEMENT_ID}/content`,
      );
      expect(init.method).toBe('PATCH');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tn-token-xyz');
      expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ content: 'incremental text' });
    });

    it('URL-encodes card_id and element_id', async () => {
      const client = makeClient();
      await client.patchElementContent('card x/y', 'el 1', 't');
      expect(calls[0].url).toContain('/cards/card%20x%2Fy/elements/el%201/content');
    });
  });

  describe('patchCard (finalize)', () => {
    it('PATCHes the card endpoint with the supplied body', async () => {
      const client = makeClient();
      const finalCard = { schema: '2.0', config: { streaming_mode: false }, body: { elements: [] } };
      await client.patchCard(CARD_ID, finalCard);

      expect(calls[0].url).toBe(
        `${DEFAULT_CARDKIT_BASE_URL}/open-apis/cardkit/v1/cards/${CARD_ID}`,
      );
      expect(calls[0].init.method).toBe('PATCH');
      expect(JSON.parse(calls[0].init.body as string)).toEqual(finalCard);
    });

    it('returns the parsed response body on success', async () => {
      const client = makeClient();
      const result = await client.patchCard(CARD_ID, { done: true });
      expect(result).toEqual({ ok: true, status: 200, data: { code: 0, msg: 'ok' } });
    });
  });

  describe('401 handling', () => {
    it('throws CardKitClientError(status=401) with an actionable message + body', async () => {
      mockFetch.mockResolvedValueOnce(fakeResponse(401, { code: 99991663, msg: 'invalid token' }));
      const client = makeClient();
      await expect(client.patchCard(CARD_ID, {})).rejects.toMatchObject({
        name: 'CardKitClientError',
        status: 401,
        message: expect.stringContaining('Refresh LARKSUITE_CLI_TENANT_ACCESS_TOKEN'),
        responseBody: { code: 99991663, msg: 'invalid token' },
      });
    });
  });

  describe('non-2xx handling', () => {
    it('throws CardKitClientError with status + response body', async () => {
      mockFetch.mockResolvedValueOnce(fakeResponse(429, { msg: 'rate limited' }));
      const client = makeClient();
      await expect(client.patchCard(CARD_ID, {})).rejects.toMatchObject({
        name: 'CardKitClientError',
        status: 429,
        responseBody: { msg: 'rate limited' },
      });
    });
  });

  describe('construction', () => {
    it('throws if tenantAccessToken is missing', () => {
      expect(() => new FeishuCardKitClient({ tenantAccessToken: '' } as never)).toThrow(
        /tenantAccessToken is required/i,
      );
    });

    it('honors a custom baseUrl (Lark / on-prem)', async () => {
      const client = new FeishuCardKitClient({
        tenantAccessToken: 't',
        baseUrl: 'https://open.larksuite.com/',
        fetchImpl: mockFetch,
      });
      await client.patchCard(CARD_ID, {});
      expect(calls[0].url).toContain('https://open.larksuite.com/open-apis/cardkit/v1/cards/');
    });
  });

  describe('business-code handling (Feishu error model)', () => {
    it('throws CardKitClientError when a 200 response carries a non-zero code', async () => {
      // Feishu returns HTTP 200 + body { code: <non-zero>, msg } on business
      // errors (e.g. 99991663 invalid token). Must NOT be reported as ok.
      mockFetch.mockResolvedValueOnce(
        fakeResponse(200, { code: 99991663, msg: 'invalid access token' }),
      );
      const client = makeClient();
      await expect(client.patchCard(CARD_ID, {})).rejects.toMatchObject({
        name: 'CardKitClientError',
        status: 200,
        message: expect.stringContaining('business code 99991663'),
        responseBody: { code: 99991663, msg: 'invalid access token' },
      });
    });

    it('succeeds when a 200 response has no code field (e.g. empty body)', async () => {
      mockFetch.mockResolvedValueOnce(fakeResponse(200, {}));
      const client = makeClient();
      await expect(client.patchCard(CARD_ID, {})).resolves.toMatchObject({
        ok: true,
        status: 200,
      });
    });
  });

  describe('timeout / abort', () => {
    /** A fetch that hangs until its signal aborts, then rejects AbortError. */
    function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }

    it('aborts (CardKitClientError status=0) when the request exceeds timeoutMs', async () => {
      mockFetch.mockImplementationOnce(hangingFetch);
      const client = new FeishuCardKitClient({
        tenantAccessToken: 't',
        fetchImpl: mockFetch,
        timeoutMs: 30,
      });
      await expect(client.patchCard(CARD_ID, {})).rejects.toMatchObject({
        name: 'CardKitClientError',
        status: 0,
        message: expect.stringContaining('aborted'),
      });
    });

    it('honors an external options.signal', async () => {
      mockFetch.mockImplementationOnce(hangingFetch);
      const external = new AbortController();
      const client = new FeishuCardKitClient({
        tenantAccessToken: 't',
        fetchImpl: mockFetch,
        timeoutMs: 60_000,
        signal: external.signal,
      });
      const pending = client.patchCard(CARD_ID, {});
      external.abort();
      await expect(pending).rejects.toMatchObject({
        name: 'CardKitClientError',
        status: 0,
      });
    });
  });

  describe('createCardKitClientFromEnv', () => {
    const origToken = process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN;

    afterEach(() => {
      if (origToken === undefined) {
        delete process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN;
      } else {
        process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN = origToken;
      }
    });

    it('throws a clear error if LARKSUITE_CLI_TENANT_ACCESS_TOKEN is unset', () => {
      delete process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN;
      expect(() => createCardKitClientFromEnv({ fetchImpl: mockFetch })).toThrow(
        /LARKSUITE_CLI_TENANT_ACCESS_TOKEN is not set/i,
      );
    });

    it('builds a client when the env var is set', () => {
      process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN = 'env-token';
      const client = createCardKitClientFromEnv({ fetchImpl: mockFetch });
      expect(client).toBeInstanceOf(FeishuCardKitClient);
    });
  });
});
