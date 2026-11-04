/**
 * Tests for ChannelApiClient — the REST API channel-method client (Issue #4279 Phase 2).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { normalizeChannelApiBaseUrl, ChannelApiClient } from './client.js';

describe('ChannelApiClient', () => {
  it('normalizes an explicit HTTP address without changing its port', () => {
    expect(normalizeChannelApiBaseUrl(' http://127.0.0.1:43123/ ')).toBe('http://127.0.0.1:43123');
  });

  it.each(['', 'localhost:19200', 'ftp://localhost:19200', 'http://user:secret@localhost:19200', 'http://localhost:19200/api'])(
    'rejects missing or unsafe REST address %j',
    (value) => expect(() => normalizeChannelApiBaseUrl(value)).toThrow(/DisclaudeService REST address/),
  );
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(responses: Array<{ status?: number; json: Record<string, unknown> }>): {
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      calls.push({ url: input, init: init ?? {} });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve({
        ok: r.status === undefined || r.status < 400,
        status: r.status ?? 200,
        json: () => Promise.resolve(r.json),
      } as Response);
    }) as unknown as typeof fetch;
    return { calls };
  }

  describe('requestChannel', () => {
    it('should POST sendMessage and return the REST API payload (strip ok envelope)', async () => {
      const { calls } = mockFetch([{ json: { ok: true, success: true, messageId: 'om_123' } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200', apiToken: 'tok' });

      const result = await client.requestChannel('sendMessage', { chatId: 'oc_test', text: 'hi' });

      expect(result).toEqual({ success: true, messageId: 'om_123' });
      expect(result.ok).toBeUndefined();
      expect(calls[0].url).toBe('http://localhost:19200/api/send-message');
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers).toMatchObject({
        'content-type': 'application/json',
        authorization: 'Bearer tok',
      });
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ chatId: 'oc_test', text: 'hi' });
    });

    it('should GET listTempChats without a body or auth header', async () => {
      const { calls } = mockFetch([{ json: { ok: true, success: true, chats: [] } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200', apiToken: 'tok' });

      await client.requestChannel('listTempChats');

      expect(calls[0].url).toBe('http://localhost:19200/api/temp-chats');
      expect(calls[0].init.method).toBe('GET');
      expect(calls[0].init.body).toBeUndefined();
      // GET routes are token-exempt — no Authorization header.
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
    });

    it('should strip trailing slash from baseUrl', async () => {
      const { calls } = mockFetch([{ json: { pong: true } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200/' });

      await client.requestChannel('ping');

      expect(calls[0].url).toBe('http://localhost:19200/api/ping');
    });

    it('should route ping to /api/ping and return { pong: true } (no `ok` envelope)', async () => {
      // Real handlePing returns `{ pong: true }` (no `ok`); ping's success
      // predicate is `res.ok && json.pong === true`, not the default `ok` guard.
      const { calls } = mockFetch([{ json: { pong: true } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      const result = await client.requestChannel('ping');

      expect(calls[0].url).toBe('http://localhost:19200/api/ping');
      expect(calls[0].init.method).toBe('GET');
      expect(result).toEqual({ pong: true });
    });

    it('should throw on HTTP error status', async () => {
      mockFetch([{ status: 500, json: { ok: false, message: 'handler error' } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      await expect(client.requestChannel('sendCard', { chatId: 'x', card: {} })).rejects.toThrow(
        'CHANNEL_API_REQUEST_FAILED: REST sendCard (HTTP 500: handler error)',
      );
    });

    it('should throw on ok:false in the response body', async () => {
      mockFetch([{ status: 503, json: { ok: false, message: 'handler not configured' } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      await expect(client.requestChannel('uploadFile', { chatId: 'x', filePath: '/a' })).rejects.toThrow(
        'CHANNEL_API_REQUEST_FAILED: REST uploadFile (HTTP 503: handler not configured)',
      );
    });

    it('should classify a fetch network failure as CHANNEL_API_NOT_AVAILABLE', async () => {
      globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      await expect(client.requestChannel('ping')).rejects.toThrow(
        'CHANNEL_API_NOT_AVAILABLE: REST ping (ECONNREFUSED)',
      );
    });

    it('should classify a fetch timeout as CHANNEL_API_TIMEOUT', async () => {
      // AbortSignal.timeout surfaces as a TimeoutError/AbortError — must map to
      // CHANNEL_API_TIMEOUT so classifyError → 'channel_api_timeout' (not channel_api_request_failed).
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      globalThis.fetch = (() => Promise.reject(timeoutErr)) as typeof fetch;
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      await expect(client.requestChannel('sendMessage', { chatId: 'x', text: 'hi' })).rejects.toThrow(
        'CHANNEL_API_TIMEOUT: REST sendMessage',
      );
    });

    it('should route pushToAgent to /api/push and shape {ok} → {success}', async () => {
      const { calls } = mockFetch([{ json: { ok: true, message: 'Push accepted' } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200', apiToken: 'tok' });

      const result = await client.requestChannel('pushToAgent', { chatId: 'oc_test', message: 'hi' });

      expect(result).toEqual({ success: true });
      expect(calls[0].url).toBe('http://localhost:19200/api/push');
    });

    it('should throw for truly unsupported methods', async () => {
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });
      await expect(client.requestChannel('unknownMethod')).rejects.toThrow('unsupported method');
    });

    it('should support ChannelApiClientLike.request<T> (drop-in interface)', async () => {
      mockFetch([{ json: { ok: true, success: true, messageId: 'om_456' } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200', apiToken: 'tok' });

      // request<T> delegates to requestChannel — same behavior, typed return.
      const result = await client.request('sendMessage', { chatId: 'oc_test', text: 'hi' });

      expect(result).toEqual({ success: true, messageId: 'om_456' });
    });
  });

  // Issue #5630: upload routes cover the full upload+message-create chain in
  // one request and need a chain-aware deadline. AbortSignal.timeout is native
  // and invisible to fake timers, so these tests spy on it with a fake-timer
  // driven AbortController — the timeout → abort → fetch-reject chain stays real.
  describe('upload deadline (Issue #5630)', () => {
    let timeoutCalls: number[];
    let timeoutSpy: MockInstance;

    /** fetch stub that resolves after `respondAfterMs` or rejects like undici on abort. */
    function mockDeadlineFetch(respondAfterMs: number | null): void {
      globalThis.fetch = ((_input: string, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const timer = respondAfterMs === null
            ? undefined
            : setTimeout(() => {
              resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                  ok: true, success: true, fileKey: 'fk', fileType: 'file', fileName: 'a.pdf', fileSize: 10,
                }),
              } as Response);
            }, respondAfterMs);
          init?.signal?.addEventListener('abort', () => {
            if (timer) { clearTimeout(timer); }
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      }) as typeof fetch;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      timeoutCalls = [];
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(((ms: number) => {
        timeoutCalls.push(ms);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      }) as typeof AbortSignal.timeout);
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it('gives uploadFile the chain-aware deadline: a >30s response succeeds', async () => {
      // Regression (#5630): 1.8MB PNG / 551KB JPEG died at the generic 30s.
      // The upload default must outlive 30s handlers end-to-end.
      mockDeadlineFetch(31_000);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      const pending = client.requestChannel('uploadFile', { chatId: 'oc_x', filePath: '/a.pdf' });
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(pending).resolves.toEqual({
        success: true, fileKey: 'fk', fileType: 'file', fileName: 'a.pdf', fileSize: 10,
      });
      expect(timeoutCalls).toEqual([120_000]);
    });

    it('still aborts uploadFile at its own deadline and maps to CHANNEL_API_TIMEOUT', async () => {
      mockDeadlineFetch(null); // never responds — only the deadline ends it
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      const pending = client.requestChannel('uploadFile', { chatId: 'oc_x', filePath: '/a.pdf' });
      const captured = expect(pending).rejects.toThrow('CHANNEL_API_TIMEOUT: REST uploadFile');
      await vi.advanceTimersByTimeAsync(120_000);
      await captured;
      expect(timeoutCalls).toEqual([120_000]);
    });

    it('an explicit timeoutMs overrides the chain-aware default', async () => {
      mockDeadlineFetch(null);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      const pending = client.requestChannel('uploadFile', { chatId: 'oc_x', filePath: '/a.pdf' }, { timeoutMs: 5_000 });
      const captured = expect(pending).rejects.toThrow('CHANNEL_API_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5_000);
      await captured;
      expect(timeoutCalls).toEqual([5_000]);
    });

    it('keeps the generic 30s default for non-upload routes', async () => {
      mockDeadlineFetch(null);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      const pending = client.requestChannel('sendMessage', { chatId: 'oc_x', text: 'hi' });
      const captured = expect(pending).rejects.toThrow('CHANNEL_API_TIMEOUT');
      await vi.advanceTimersByTimeAsync(30_000);
      await captured;
      expect(timeoutCalls).toEqual([30_000]);
    });

    it('sends the idempotencyKey with the uploadFile payload', async () => {
      const { calls } = mockFetch([{ json: { ok: true, success: true, fileKey: '', fileType: 'file', fileName: 'a.pdf', fileSize: 0 } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });

      await client.requestChannel('uploadFile', { chatId: 'oc_x', filePath: '/a.pdf', idempotencyKey: 'idem-1' });

      expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ idempotencyKey: 'idem-1' });
    });
  });

  describe('isAvailable', () => {
    it('should return true when /api/ping responds with pong:true', async () => {
      // Real handlePing returns `{ pong: true }` (no `ok` envelope).
      mockFetch([{ json: { pong: true } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });
      expect(await client.isAvailable()).toBe(true);
    });

    it('should return false on pong missing', async () => {
      mockFetch([{ json: { ok: true } }]);
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });
      expect(await client.isAvailable()).toBe(false);
    });

    it('should return false on fetch error', async () => {
      globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
      const client = new ChannelApiClient({ baseUrl: 'http://localhost:19200' });
      expect(await client.isAvailable()).toBe(false);
    });
  });

});
