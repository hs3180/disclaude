import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelError } from '../../channel-error.js';
import { WeChatApiClient, WeChatApiError, WeChatDeliveryUnknownError } from './api-client.js';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }));
vi.mock('@disclaude/core', async original => ({ ...await original<typeof import('@disclaude/core')>(), createLogger: () => logger }));

const fetchMock = vi.fn();
const replyContext = 'fixture-private-context';
const requestId = 'd5b48bee-2762-44bb-9a4c-f6fd5b5d3692';
const traceId = 'cc0099aaff003355cc0099aaff003355';
const request = { to: 'fixture-peer@im.wechat', content: 'fixture private text', contextToken: replyContext };

function resultLogs() {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls].map(([value]) => value)
    .filter(value => value?.event === 'wechat_send_result');
}

describe('WeChat send request diagnostics', () => {
  let client: WeChatApiClient;
  beforeEach(() => {
    vi.clearAllMocks(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
    client = new WeChatApiClient({ baseUrl: 'https://ilinkai.weixin.qq.com', token: 'fixture-private-bot', channelId: 'wechat:1b0c2c93-e587-46c8-8ef9-0da14210c8ed' });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('correlates accepted and refused sends, and does not count a local empty poll as a new server acceptance', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T06:00:00Z'));
    const contextObservedAt = Date.now() - 2_000;
    fetchMock.mockResolvedValueOnce(new Response('{"ret":0,"msgs":[]}'));
    await client.getUpdates();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const pendingPoll = client.getUpdates({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pendingPoll).toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response('{"ret":0,"message_id":18446744073709551615}'));
    expect(await client.sendText({ ...request, contextObservedAt })).toBe('18446744073709551615');
    await vi.advanceTimersByTimeAsync(1_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ret: -2, errcode: '0', errmsg: 'prepare failed', request_id: requestId }), {
      status: 200, headers: { 'x-trace-id': traceId },
    }));
    const failure = await client.sendText({ ...request, contextObservedAt }).catch(error => error) as WeChatApiError;
    const [accepted, rejected] = resultLogs();
    expect(accepted).toMatchObject({ outcome: 'accepted', httpStatus: 200, ret: 0, platformMessageIdPresent: true, platformMessageId: '18446744073709551615',
      send: { channelId: 'wechat:1b0c2c93-e587-46c8-8ef9-0da14210c8ed', messageType: 'text', stage: 'api-response', replyContextPresent: true, replyContextObservedAgeMs: 2_500, lastAcceptedPollAgeMs: 500 } });
    expect(rejected).toMatchObject({ outcome: 'rejected', code: -2, httpStatus: 200, ret: -2, errcode: 0, errmsg: 'prepare failed',
      send: { messageType: 'text', stage: 'api-response', failure: 'api-rejected', replyContextPresent: true,
        replyContextObservedAgeMs: 3_500, lastAcceptedPollAgeMs: 1_500, peerHash: accepted.send.peerHash, upstreamRequestId: requestId, upstreamTraceId: traceId } });
    expect(failure).toBeInstanceOf(WeChatApiError);
    expect(failure.detail?.diagnosticId).toBe(rejected.diagnosticId);
    const { body } = channelError(new Error('WeChat message NOT sent', { cause: failure }));
    expect(body.diagnostics).toMatchObject({ errorKind: 'delivery-rejected', sessionState: 'unverified', ret: -2, errcode: 0,
      channelDiagnosticId: rejected.diagnosticId, send: JSON.parse(JSON.stringify(rejected.send)) });
    const acceptedWire = JSON.parse(fetchMock.mock.calls[2][1].body).msg;
    const rejectedWire = JSON.parse(fetchMock.mock.calls[3][1].body).msg;
    expect(accepted.send.clientMessageId).toBe(acceptedWire.client_id);
    expect(rejected.send.clientMessageId).toBe(rejectedWire.client_id);
    expect(acceptedWire.client_id).not.toBe(rejectedWire.client_id);
    expect(rejectedWire.context_token).toBe(replyContext);
    expect(rejectedWire).not.toHaveProperty('contextObservedAt');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves bounded structured JSON details on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ret: -2, errcode: 17, err_msg: 'prepare failed' }), {
      status: 503, headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    }));
    const failure = await client.sendText(request).catch(error => error);
    expect(failure).toMatchObject({ code: 503, detail: { httpStatus: 503, ret: -2, errcode: 17, errmsg: 'prepare failed',
      send: { stage: 'http-response', failure: 'http-rejected', upstreamRequestId: requestId, replyContextPresent: true } } });
    expect(failure.detail.send.replyContextObservedAgeMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains the HTTP failure when the optional response body is oversized or invalid', async () => {
    for (const text of ['invalid JSON', JSON.stringify({ ret: -2, errmsg: 'x'.repeat(32_768) })]) {
      fetchMock.mockResolvedValueOnce(new Response(text, { status: 500, headers: { 'content-type': 'application/json' } }));
      const failure = await client.sendText(request).catch(error => error);
      expect(failure).toMatchObject({ code: 500, detail: { httpStatus: 500, send: { stage: 'http-response', failure: 'http-rejected' } } });
      expect(failure.detail.errmsg).toBeUndefined();
      expect(failure.detail.ret).toBeUndefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains a received HTTP failure when the optional JSON body stalls past the deadline', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ start() { /* intentionally stays open */ } });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 502, headers: { 'content-type': 'application/json' } }));
    const pending = client.sendText(request).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ code: 502, detail: { httpStatus: 502, send: { stage: 'http-response', failure: 'http-rejected' } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an actual deadline during response-body reading even if the transport never settles', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: () => new Promise(() => {}) });
    const pending = client.sendText(request).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const failure = await pending;
    expect(failure).toBeInstanceOf(WeChatDeliveryUnknownError);
    expect(channelError(failure).body.diagnostics).toMatchObject({ errorKind: 'delivery-outcome-unknown', sessionState: 'unverified', httpStatus: 200,
      send: { stage: 'response-body', failure: 'timeout', replyContextPresent: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes DNS/transport failures and malformed JSON without leaking raw exceptions', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('private opaque exception', { cause: Object.assign(new Error('private URL'), { code: 'ENOTFOUND' }) }));
    const networkError = await client.sendText(request).catch(error => error);
    expect(channelError(networkError).body.diagnostics).toMatchObject({ errorKind: 'delivery-outcome-unknown', send: { stage: 'request', failure: 'transport-error', transportCode: 'ENOTFOUND' } });
    const partial = new Error('WeChat delivery failed after 1/2 text parts; delivery is partial, verify before retrying', { cause: networkError });
    expect(channelError(partial).body.diagnostics).toMatchObject({ errorKind: 'delivery-partial', send: { stage: 'request', failure: 'transport-error', transportCode: 'ENOTFOUND' } });
    fetchMock.mockResolvedValueOnce(new Response('private invalid response', { status: 200 }));
    const parseError = await client.sendText({ to: request.to, content: request.content, contextObservedAt: Date.now() }).catch(error => error);
    expect(channelError(parseError).body.diagnostics).toMatchObject({ errorKind: 'delivery-outcome-unknown', httpStatus: 200,
      send: { stage: 'response-json', failure: 'invalid-response', replyContextPresent: false } });
    expect(parseError.detail.send.replyContextObservedAgeMs).toBeUndefined();
    expect(JSON.stringify([networkError, parseError, resultLogs()])).not.toMatch(/private opaque exception|private URL|private invalid response/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops echoed credentials, text, unsafe IDs and unrecognized response fields at both diagnostic boundaries', async () => {
    const opaqueContext = 'd5b48bee-2762-44bb-9a4c-f6fd5b5d3692';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ret: -2, errmsg: opaqueContext, request_id: opaqueContext,
      trace_id: 'https://example.invalid/private', unknown: 'private raw body' }), { headers: { 'x-request-id': opaqueContext, 'set-cookie': 'private cookie' } }));
    const failure = await client.sendText({ ...request, contextToken: opaqueContext }).catch(error => error);
    expect(failure.detail.send.serverErrorMessagePresent).toBe(true);
    expect(failure.detail.errmsg).toBeUndefined();
    expect(failure.detail.send.upstreamRequestId).toBeUndefined();
    expect(failure.detail.send.upstreamTraceId).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ret: -2, errmsg: request.content })));
    const echoedText = await client.sendText(request).catch(error => error);
    expect(echoedText.detail.errmsg).toBeUndefined();
    expect(JSON.stringify([failure, echoedText, channelError(failure), logger.warn.mock.calls, resultLogs()]))
      .not.toMatch(/d5b48bee-2762-44bb-9a4c-f6fd5b5d3692|fixture private text|fixture-private-bot|fixture-private-context|fixture-peer@im\.wechat|private raw body|private cookie|example\.invalid/);
    // Malformed additional properties at a caller's boundary cannot be copied into REST.
    const injected = new WeChatApiError(-2, { ...failure.detail, send: { ...failure.detail.send,
      replyContextObservedAgeMs: -1, upstreamRequestId: 'unsafe header value', raw: 'private payload' } });
    const safe = channelError(injected).body.diagnostics?.send;
    expect(safe).toBeDefined();
    expect(safe?.replyContextObservedAgeMs).toBeUndefined();
    expect(safe?.upstreamRequestId).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('private payload');
  });

  it.each(['image', 'file', 'video'] as const)('records %s sends through the same endpoint without logging CDN credentials', async (kind) => {
    const mediaKey = '828e9010-58d6-4286-9bf8-a721fac1ae45';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ret: -2, errmsg: mediaKey, request_id: mediaKey })));
    const params = { to: request.to, uploaded: { media: { encrypt_query_param: 'private-ref', aes_key: mediaKey, encrypt_type: 1 }, size: 42, encryptedSize: 48 },
      contextToken: replyContext, contextObservedAt: Date.now() };
    const sending = kind === 'image' ? client.sendImage(params) : kind === 'file' ? client.sendFile(params) : client.sendVideo(params);
    const failure = await sending.catch(error => error);
    expect(failure.detail.send).toMatchObject({ messageType: kind, stage: 'api-response', failure: 'api-rejected', replyContextPresent: true });
    expect(JSON.stringify([failure, resultLogs()])).not.toMatch(/private-ref|828e9010-58d6-4286-9bf8-a721fac1ae45|fixture-private-context/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
