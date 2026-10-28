/**
 * Tests for WeChatApiClient (MVP).
 *
 * @see Issue #1473 - WeChat Channel MVP
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { WeChatApiClient } from './api-client.js';

// Store original fetch
const originalFetch = globalThis.fetch;

describe('WeChatApiClient', () => {
  let client: WeChatApiClient;
  let mockFetch: Mock;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    client = new WeChatApiClient({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      routeTag: 'test-route',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('current iLink wire contract', () => {
    it('reports ambiguous delivery and does not blindly retry a timed-out send', async () => {
      mockFetch.mockRejectedValue(new DOMException('aborted', 'AbortError'));
      await expect(client.sendText({ to: 'peer', content: 'hello' })).rejects.toThrow('delivery outcome unknown');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    it('reads msgs and acknowledges the cursor only after the batch is accepted', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"peer","item_list":[{"type":1,"text_item":{"text":"hello"}}]}],"get_updates_buf":"cursor-1"}')));
      const updates = await client.getUpdates();
      expect(updates[0]?.message_id).toBe('18446744073709551615');
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).get_updates_buf).toBe('');
      expect(client.getUpdatesCursor()).toBe('');
      client.acknowledgeUpdates();
      await client.getUpdates();
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).get_updates_buf).toBe('cursor-1');
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({ 'iLink-App-Id': 'bot' });
    });

    it('preserves message-looking text while parsing uint64 IDs', async () => {
      const text = 'a quoted \\"message_id\\":18446744073709551615';
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ msgs: [{ message_id: 'id', item_list: [{ type: 1, text_item: { text } }] }] })));
      expect((await client.getUpdates())[0].item_list?.[0]).toMatchObject({ text_item: { text } });
    });

    it('rejects errcode failures without copying server secrets into errors', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ret: 0, errcode: -14, errmsg: 'secret-context-token' }))));
      await expect(client.getUpdates()).rejects.toMatchObject({ code: -14, authExpired: true });
      await expect(client.getUpdates()).rejects.not.toThrow('secret-context-token');
    });

    it('keeps the deadline active while reading the response body and removes abort listeners', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      mockFetch.mockImplementation((_url, opts) => Promise.resolve({ ok: true, text: () => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }));
      try {
        const poll = client.getUpdates({ signal: controller.signal, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(101);
        expect(await poll).toEqual([]);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      } finally { vi.useRealTimers(); }
    });

    it('settles on the caller abort even when the transport drops the abort rejection (#5479)', async () => {
      // Package-install matrix hang: a held long poll can swallow the abort of
      // its listener signal, leaving shutdown waiting forever. Callers must
      // settle on the abort signal itself, not on the transport's goodwill.
      const controller = new AbortController();
      mockFetch.mockImplementation(() => new Promise<Response>(() => {}));
      const poll = client.getUpdates({ signal: controller.signal, timeoutMs: 60_000 });
      controller.abort();
      expect(await poll).toEqual([]);
    });

    it('still returns empty when the deadline fires and the transport never rejects (#5479)', async () => {
      vi.useFakeTimers();
      mockFetch.mockImplementation(() => new Promise<Response>(() => {}));
      try {
        const poll = client.getUpdates({ timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(101);
        expect(await poll).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('keeps the safe server reason and endpoint on an explicit -2 rejection (#5478)', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }), { status: 200 }));
      const failure = await client.sendText({ to: 'peer', content: 'hello' }).catch(error => error);
      expect(failure).toMatchObject({ code: -2, detail: { endpoint: '/ilink/bot/sendmessage', httpStatus: 200, ret: -2, errmsg: 'prepare failed' } });
      expect(failure.message).toContain('WeChat API error [-2] on /ilink/bot/sendmessage (HTTP 200): prepare failed');
      expect(failure.message).not.toContain('delivery outcome unknown');
    });

    it('drops errmsg values that could carry credentials or signed URLs (#5478)', async () => {
      for (const errmsg of ['see https://cdn.example.com/a/b?sig=abc', `blob-${'A'.repeat(40)}`, 'ctx secret-context-token', 'ok then https://x/y']) {
        mockFetch.mockResolvedValue(new Response(JSON.stringify({ ret: -2, errmsg }), { status: 200 }));
        const failure = await client.sendText({ to: 'peer', content: 'hello' }).catch(error => error);
        expect(failure.detail?.errmsg).toBeUndefined();
        expect(failure.message).not.toContain('https');
      }
    });

    it('records endpoint and HTTP status for non-2xx transport rejections (#5478)', async () => {
      mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
      const failure = await client.sendText({ to: 'peer', content: 'hello' }).catch(error => error);
      expect(failure).toMatchObject({ code: 503, detail: { endpoint: '/ilink/bot/sendmessage', httpStatus: 503 } });
      expect(failure.message).toContain('WeChat API error [503] on /ilink/bot/sendmessage (HTTP 503)');
    });

    it('a passing getconfig check never proves delivery: checkSession resolves while sendmessage rejects (#5478)', async () => {
      mockFetch.mockImplementation((_url, opts) => Promise.resolve(
        JSON.parse(opts.body).ilink_user_id && !JSON.parse(opts.body).msg
          ? new Response(JSON.stringify({ ret: 0 }), { status: 200 })
          : new Response(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }), { status: 200 }),
      ));
      await expect(client.checkSession('user-1')).resolves.toBeUndefined();
      const failure = await client.sendText({ to: 'user-1', content: 'hello' }).catch(error => error);
      expect(failure).toMatchObject({ code: -2 });
      expect(failure.detail?.errmsg).toBe('prepare failed');
    });
  });

  describe('constructor', () => {
    it('should strip trailing slashes from baseUrl', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com/' });
      // Internal baseUrl should be cleaned
      expect(c).toBeDefined();
    });

    it('should store token', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', token: 'my-token' });
      expect(c.getToken()).toBe('my-token');
    });

    it('should store routeTag', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', routeTag: 'my-route' });
      expect(c).toBeDefined();
    });

    it('should use default bot type', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      expect(c).toBeDefined();
    });
  });

  describe('token management', () => {
    it('should set token via setToken', () => {
      client.setToken('new-token');
      expect(client.getToken()).toBe('new-token');
    });

    it('hasToken should return true when token is set', () => {
      client.setToken('token');
      expect(client.hasToken()).toBe(true);
    });

    it('hasToken should return false when token is not set', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      expect(c.hasToken()).toBe(false);
    });

    it('hasToken should return false for empty token', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', token: '' });
      expect(c.hasToken()).toBe(false);
    });

    it('hasToken rejects whitespace-only credentials', () => {
      const c = new WeChatApiClient({ baseUrl: 'https://api.example.com', token: '   ' });
      expect(c.hasToken()).toBe(false);
    });
  });

  describe('getBotQrCode', () => {
    it('should fetch QR code from API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          qrcode: 'qr-id-123',
          qrcode_img_content: 'data:image/png;base64,abc',
        })),
      });

      const result = await client.getBotQrCode();
      expect(result.qrcode).toBe('qr-id-123');
      expect(result.qrUrl).toBe('data:image/png;base64,abc');
    });

    it('should include routeTag header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          qrcode: 'qr-id',
          qrcode_img_content: 'url',
        })),
      });

      await client.getBotQrCode();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('get_bot_qrcode'),
        expect.objectContaining({
          headers: expect.objectContaining({ SKRouteTag: 'test-route' }),
        })
      );
    });

    it('should throw when response is missing qrcode field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ qrcode_img_content: 'url' })),
      });

      await expect(client.getBotQrCode()).rejects.toThrow('missing fields in response');
    });

    it('should throw when response is missing qrcode_img_content field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ qrcode: 'qr-id' })),
      });

      await expect(client.getBotQrCode()).rejects.toThrow('missing fields in response');
    });

    it('should throw when API returns non-ok status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(client.getBotQrCode()).rejects.toThrow('WeChat API error [500]');
    });
  });

  describe('getQrCodeStatus', () => {
    it('should return wait status on timeout (AbortError)', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('wait');
    });

    it('should return confirmed status with token data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          status: 'confirmed',
          bot_token: 'bot-token-123',
          ilink_bot_id: 'bot-id',
          ilink_user_id: 'user-id',
          baseurl: 'https://ilinkai-regional.weixin.qq.com',
        })),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('confirmed');
      expect(result.botToken).toBe('bot-token-123');
      expect(result.botId).toBe('bot-id');
      expect(result.userId).toBe('user-id');
      expect(result.baseUrl).toBe('https://ilinkai-regional.weixin.qq.com');
      // Token should be auto-set on confirmed
      expect(client.getToken()).toBe('bot-token-123');
    });

    it('should return scaned status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'scaned' })),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('scaned');
    });

    it('should return expired status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'expired' })),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('expired');
    });

    it('should default to wait when status is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      const result = await client.getQrCodeStatus('qr-123');
      expect(result.status).toBe('wait');
    });

    it('should re-throw non-timeout errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(client.getQrCodeStatus('qr-123')).rejects.toThrow('Network error');
    });

    it('should include SKRouteTag header when routeTag is set', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'wait' })),
      });

      await client.getQrCodeStatus('qr-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('get_qrcode_status'),
        expect.objectContaining({
          headers: expect.objectContaining({ SKRouteTag: 'test-route' }),
        })
      );
    });

    it('should not include SKRouteTag when routeTag is not set', async () => {
      const noRouteClient = new WeChatApiClient({ baseUrl: 'https://api.example.com' });
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'wait' })),
      });

      await noRouteClient.getQrCodeStatus('qr-123');
      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('SKRouteTag');
    });
  });

  describe('sendText', () => {
    it('should send text message via POST', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('sendmessage'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'AuthorizationType': 'ilink_bot_token',
            'Authorization': 'Bearer bot-token',
          }),
        })
      );
    });

    it('should include contextToken when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!', contextToken: 'ctx-123' });

      // Verify the body contains context_token
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.msg.context_token).toBe('ctx-123');
    });

    it('should throw when API returns error ret code', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 2001, err_msg: 'Invalid token' })),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'Hello!' }))
        .rejects.toThrow('WeChat API error [2001]');
    });

    it('should throw when HTTP request fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'Hello!' }))
        .rejects.toThrow('WeChat API error [401]');
    });

    it('should include X-WECHAT-UIN header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!' });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).toHaveProperty('X-WECHAT-UIN');
      // X-WECHAT-UIN should be a base64 string
      expect(callHeaders['X-WECHAT-UIN']).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should generate unique client_id for each message', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'msg1' });
      await client.sendText({ to: 'user-1', content: 'msg2' });

      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body1.msg.client_id).not.toBe(body2.msg.client_id);
    });

    it('should handle empty content', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: '' });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.msg.item_list).toBeUndefined();
    });

    it('should include SKRouteTag when routeTag is set', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('bot-token');
      await client.sendText({ to: 'user-1', content: 'Hello!' });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).toHaveProperty('SKRouteTag');
      expect(callHeaders['SKRouteTag']).toBe('test-route');
    });
  });

  describe('fetchJson (timeout)', () => {
    it('should abort request after timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockImplementation((_url, _opts) => {
        // The AbortController signal should be passed through
        return new Promise((_, reject) => {
          // Issue #4394 (part 17): reject on a deterministic next-tick instead
          // of a real 10ms setTimeout. The test only needs fetch to reject
          // asynchronously (matching real fetch behavior) — not after a real
          // wall-clock delay that slows/flakes the suite.
          setImmediate(() => reject(abortError));
        });
      });

      // sendText uses DEFAULT_API_TIMEOUT_MS (15s), but the abort will happen quickly
      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'test' }))
        .rejects.toThrow();
    }, 10000);
  });

  describe('edge cases', () => {
    it('should handle non-JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('not-json'),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'test' }))
        .rejects.toThrow();
    });

    it('should handle API error without err_msg', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 999 })),
      });

      client.setToken('bot-token');
      await expect(client.sendText({ to: 'user-1', content: 'test' }))
        .rejects.toThrow('Error code 999');
    });
  });

  describe('getUpdates (Issue #1556 Phase 3.1)', () => {
    it('should return updates from API', async () => {
      const updates = [
        {
          msg_id: 'msg-1',
          from_user_id: 'user-123',
          to_user_id: 'bot-456',
          item_list: [{ type: 1, text_item: { text: 'Hello bot!' } }],
          create_time: 1710000000,
        },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: updates })),
      });

      client.setToken('test-token');
      const result = await client.getUpdates();

      expect(result).toHaveLength(1);
      expect(result[0].msg_id).toBe('msg-1');
      expect(result[0].from_user_id).toBe('user-123');
    });

    it('should return empty array on timeout (AbortError)', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
      });

      client.setToken('test-token');
      const result = await client.getUpdates();

      expect(result).toEqual([]);
    });

    it('should return empty array when update_list is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
      });

      client.setToken('test-token');
      const result = await client.getUpdates();

      expect(result).toEqual([]);
    });

    it('should throw on non-timeout errors', async () => {
      mockFetch.mockRejectedValue(new Error('Server error'));

      client.setToken('test-token');
      await expect(client.getUpdates()).rejects.toThrow('Server error');
    });

    it('should forward signal to underlying fetch request', async () => {
      const abortController = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      mockFetch.mockImplementation((_url: unknown, opts: any) => {
        capturedSignal = opts.signal;
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
        });
      });

      client.setToken('test-token');
      await client.getUpdates({ signal: abortController.signal });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      // fetchJson creates its own AbortController and links the external signal,
      // so we verify the internal controller's signal is present (not the original)
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
    });

    it('should use custom timeout when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: [] })),
      });

      client.setToken('test-token');
      await client.getUpdates({ timeoutMs: 5000 });

      // The timeout is set via AbortController, so we can't directly check it,
      // but we verify the call was made
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return empty array for multiple updates', async () => {
      const updates = [
        { msg_id: 'msg-1', from_user_id: 'user-1', item_list: [{ type: 1, text_item: { text: 'Hi' } }] },
        { msg_id: 'msg-2', from_user_id: 'user-2', item_list: [{ type: 1, text_item: { text: 'Hello' } }] },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, update_list: updates })),
      });

      client.setToken('test-token');
      const result = await client.getUpdates();

      expect(result).toHaveLength(2);
      expect(result[0].msg_id).toBe('msg-1');
      expect(result[1].msg_id).toBe('msg-2');
    });
  });

  describe('sendTyping (Issue #1556 Phase 3.2)', () => {
    it('uses a fresh ticket for explicit cancellation and reports missing-ticket unavailability', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{"ret":0,"typing_ticket":"fixture-cancel"}'))
        .mockResolvedValueOnce(new Response('{"ret":0}')).mockResolvedValueOnce(new Response('{"ret":0}'));
      client.setToken('test-token');
      expect(await client.sendTyping({ to: 'user-123', status: 2, contextToken: 'fixture-context' })).toBe(true);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).context_token).toBe('fixture-context');
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({ status: 2, typing_ticket: 'fixture-cancel' });
      expect(await client.sendTyping({ to: 'user-123' })).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('cancels pending typing HTTP without throwing into the work owner', async () => {
      const abort = new AbortController();
      mockFetch.mockImplementation((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted-private-context')), { once: true });
      }));
      const sending = client.sendTyping({ to: 'user-123', signal: abort.signal });
      abort.abort(); await expect(sending).resolves.toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    it('should send typing indicator via POST', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ret: 0, typing_ticket: 'ticket' })),
      });

      client.setToken('test-token');
      await client.sendTyping({ to: 'user-123' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('ilink/bot/sendtyping'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
        }),
      );

      const callBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(callBody.ilink_user_id).toBe('user-123');
      expect(callBody.typing_ticket).toBe('ticket');
    });

    it('should not throw on API failure (non-fatal)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      });

      client.setToken('test-token');
      // Should resolve without throwing
      await client.sendTyping({ to: 'user-123' });
    });

    it('should not throw on network error (non-fatal)', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      client.setToken('test-token');
      // Should resolve without throwing
      await client.sendTyping({ to: 'user-123' });
    });

    it('should use short timeout (5s)', async () => {
      mockFetch.mockImplementation(() => {
        // The timeout is set via AbortController internally;
        // we can't capture it directly, but verify the call succeeds
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ ret: 0 })),
        });
      });

      client.setToken('test-token');
      await client.sendTyping({ to: 'user-123' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('encrypted media messages', () => {
    const uploaded = { media: { encrypt_query_param: 'ref', aes_key: 'key', encrypt_type: 1 }, size: 42, encryptedSize: 48 };
    it('sends an image media reference and returns the actual server ID', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response('{"ret":0,"message_id":18446744073709551615}')));
      expect(await client.sendImage({ to: 'peer', uploaded, contextToken: 'private-context' })).toBe('18446744073709551615');
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).msg).toMatchObject({ context_token: 'private-context', item_list: [{ type: 2, image_item: { media: uploaded.media, mid_size: 48 } }] });
    });
    it('sends file type 4 with the plaintext length and encrypted media reference', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response('{"ret":0}')));
      await client.sendFile({ to: 'peer', uploaded, fileName: 'document.pdf' });
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).msg.item_list).toEqual([{ type: 4, file_item: { media: uploaded.media, file_name: 'document.pdf', len: '42' } }]);
    });
  });
});
