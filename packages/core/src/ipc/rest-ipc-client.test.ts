/**
 * Tests for RestIpcClient — the REST IPC channel-method client (Issue #4279 Phase 2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RestIpcClient } from './rest-ipc-client.js';

describe('RestIpcClient', () => {
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
    it('should POST sendMessage and return the IPC payload (strip ok envelope)', async () => {
      const { calls } = mockFetch([{ json: { ok: true, success: true, messageId: 'om_123' } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200', apiToken: 'tok' });

      const result = await client.requestChannel('sendMessage', { chatId: 'oc_test', text: 'hi' });

      expect(result).toEqual({ success: true, messageId: 'om_123' });
      expect(result.ok).toBeUndefined();
      expect(calls[0].url).toBe('http://localhost:9200/api/send-message');
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers).toMatchObject({
        'content-type': 'application/json',
        authorization: 'Bearer tok',
      });
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ chatId: 'oc_test', text: 'hi' });
    });

    it('should GET listTempChats without a body or auth header', async () => {
      const { calls } = mockFetch([{ json: { ok: true, success: true, chats: [] } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200', apiToken: 'tok' });

      await client.requestChannel('listTempChats');

      expect(calls[0].url).toBe('http://localhost:9200/api/temp-chats');
      expect(calls[0].init.method).toBe('GET');
      expect(calls[0].init.body).toBeUndefined();
      // GET routes are token-exempt — no Authorization header.
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
    });

    it('should strip trailing slash from baseUrl', async () => {
      const { calls } = mockFetch([{ json: { ok: true, pong: true } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200/' });

      await client.requestChannel('ping');

      expect(calls[0].url).toBe('http://localhost:9200/api/ping');
    });

    it('should throw on HTTP error status', async () => {
      mockFetch([{ status: 500, json: { ok: false, message: 'handler error' } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });

      await expect(client.requestChannel('sendCard', { chatId: 'x', card: {} })).rejects.toThrow(
        'REST_sendCard_FAILED: handler error',
      );
    });

    it('should throw on ok:false in the response body', async () => {
      mockFetch([{ status: 503, json: { ok: false, message: 'handler not configured' } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });

      await expect(client.requestChannel('uploadFile', { chatId: 'x', filePath: '/a' })).rejects.toThrow(
        'handler not configured',
      );
    });

    it('should throw on fetch network failure', async () => {
      globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });

      await expect(client.requestChannel('ping')).rejects.toThrow('REST_ping_FAILED: ECONNREFUSED');
    });

    it('should throw for unsupported methods (pushToAgent/loop not yet routed)', async () => {
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });
      await expect(client.requestChannel('pushToAgent')).rejects.toThrow('not in the channel route table');
    });
  });

  describe('isAvailable', () => {
    it('should return true when /api/ping responds with pong:true', async () => {
      mockFetch([{ json: { ok: true, pong: true } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });
      expect(await client.isAvailable()).toBe(true);
    });

    it('should return false on pong missing', async () => {
      mockFetch([{ json: { ok: true } }]);
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });
      expect(await client.isAvailable()).toBe(false);
    });

    it('should return false on fetch error', async () => {
      globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });
      expect(await client.isAvailable()).toBe(false);
    });
  });

  describe('close', () => {
    it('should be a no-op (stateless HTTP)', () => {
      const client = new RestIpcClient({ baseUrl: 'http://localhost:9200' });
      expect(() => client.close()).not.toThrow();
    });
  });
});
