import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import * as diagnostics from './diagnostics.mjs';
import { connect } from './cdp.mjs';
import { observeBrowser } from './observer.mjs';

const cleanup = [];
beforeAll(() => nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/u));
afterEach(async () => { for (const stop of cleanup.reverse()) await stop(); cleanup.length = 0; });
async function server(handler) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return { http, endpoint: `http://127.0.0.1:${http.address().port}` };
}
async function discovery(body, headers = { 'Content-Type': 'application/json' }) {
  const s = await server((_req, res) => { res.writeHead(404, headers); res.end(body); });
  return diagnostics.discoverCdp({ endpoint: s.endpoint, endpointSource: 'BU_CDP_URL', env: {} }).catch(error => error);
}
async function page({ body = '{"error":{"code":404,"message":"Not Found"}}', encodedLength = 45, headers = { 'content-type': 'application/json' }, base64Encoded = false,
  url = 'https://example.test/missing', env = {}, count = 1, duplicateFinished = false, terminal = 'Network.loadingFinished', bodyTimeout = false } = {}) {
  const s = await server((_req, res) => res.end('{}')), sockets = new Set(), calls = [];
  const wss = new WebSocketServer({ server: s.http });
  cleanup.push(() => { for (const ws of sockets) ws.terminate(); wss.close(); });
  wss.on('connection', ws => { sockets.add(ws); ws.on('message', raw => {
    const request = JSON.parse(raw.toString()); calls.push(request.method);
    if (bodyTimeout && request.method === 'Network.getResponseBody') return;
    const result = request.method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId: 'page' }] } :
      request.method === 'Target.attachToTarget' ? { sessionId: 'session' } :
        request.method === 'Network.getResponseBody' ? { body, base64Encoded } : {};
    ws.send(JSON.stringify({ id: request.id, result }));
  }); });
  const records = [], observer = await observeBrowser({ websocket: `${s.endpoint.replace('http:', 'ws:')}/devtools/browser/owned`,
    endpoint: s.endpoint, endpointSource: 'BU_CDP_URL', env, onDiagnostic: value => records.push(value) });
  cleanup.push(() => observer.stop());
  const emit = (method, params) => { for (const ws of sockets) ws.send(JSON.stringify({ method, params, sessionId: 'session' })); };
  for (let index = 0; index < count; index++) {
    const requestId = `owned-${index}`;
    emit('Network.requestWillBeSent', { requestId, type: 'Document', request: { method: 'GET' } });
    emit('Network.responseReceived', { requestId, type: 'Document', response: { status: 404, statusText: 'Not Found', url, headers } });
    emit(terminal, { requestId, encodedDataLength: encodedLength, sessionId: 'session' });
    if (duplicateFinished) emit(terminal, { requestId, encodedDataLength: encodedLength });
  }
  await new Promise(resolve => setTimeout(resolve, 350));
  return { records, calls };
}

describe('bounded safe actual browser error responses', () => {
  it('retains useful actual JSON discovery fields while omitting arbitrary headers and fields', async () => {
    const error = await discovery('{"error":{"code":404,"message":"Not Found","token":"private-token"},"private":"user-content"}',
      { 'Content-Type': 'application/json', 'Set-Cookie': 'session=private-cookie', 'X-Private': 'private-header' });
    expect(error.diagnostic.response).toMatchObject({ statusText: 'Not Found', mediaType: 'application/json', body: { kind: 'json-error', fields: { code: 404, message: 'Not Found' } } });
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/private-token|private-cookie|private-header|user-content/);
  });

  it('retains a recognized actual route error, masking dynamic opaque environment values and encodings', () => {
    const secret = 'opaque/value-for-owned-fixture';
    const percentAll = [...Buffer.from(secret)].map(value => `%${value.toString(16)}`).join('');
    for (const value of [secret, encodeURIComponent(secret), encodeURIComponent(secret).toLowerCase(), percentAll,
      encodeURIComponent(encodeURIComponent(secret)), ...[4, 5, 8].map(depth => {
        let value = secret; for (let index = 0; index < depth; index++) value = encodeURIComponent(value); return value;
      }), Buffer.from(secret).toString('base64')]) {
      const summary = diagnostics.safeErrorResponse({ status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' },
        url: `https://example.test/missing/${value}`, body: JSON.stringify({ message: `Cannot GET /missing/${value}?token=private-query` }), env: { OPAQUE_UNUSED_SOURCE: secret } });
      expect(summary.body.fields.message).toContain('Cannot GET ');
      expect(JSON.stringify(summary)).not.toContain(value);
      expect(JSON.stringify(summary)).not.toContain('private-query');
    }
  });

  it('masks fully encoded short custom values and known values across labelled path segments', () => {
    for (const secret of ['x', 'ab', 'abc']) {
      const encoded = [...Buffer.from(secret)].map(value => `%${value.toString(16)}`).join('');
      for (const name of ['OPAQUE_UNUSED_SOURCE', 'MODE', 'BASE_URL', 'DEV']) {
        const value = diagnostics.browserDiagnostic({ stage: 'page-navigation', url: `https://example.test/${encoded}`, env: { [name]: secret } });
        expect(value.path).toBe('<redacted>');
      }
    }
    const secret = 'owned/private-value';
    for (const value of [secret, encodeURIComponent(secret)]) {
      const diagnostic = diagnostics.browserDiagnostic({ stage: 'page-navigation', url: `https://example.test/token/${value}`, env: { OPAQUE_UNUSED_SOURCE: secret } });
      expect(diagnostic.path).not.toContain('private-value');
    }
  });

  it('uses private response cookie values for metadata redaction in all three paths', async () => {
    const cookie = 'owned-cookie-value';
    const s = await server((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json', 'Set-Cookie': [`sid=${cookie}; Path=/; HttpOnly`, 'other=unrelated-cookie; Path=/'] }); res.end('{"message":"Not Found"}'); });
    const discoveryError = await diagnostics.discoverCdp({ endpoint: `${s.endpoint}/${cookie}`, env: {} }).catch(error => error);
    expect(discoveryError.diagnostic.path).toBe('/<redacted>/json/version');
    expect(discoveryError.diagnostic.response.body.fields.message).toBe('Not Found');
    s.http.on('upgrade', (_req, socket) => { socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nSet-Cookie: sid=${cookie}; Path=/\r\nContent-Length: 9\r\n\r\nNot Found`); });
    const wsError = await connect(`${s.endpoint.replace('http:', 'ws:')}/${cookie}`, { env: {} }).catch(error => error);
    expect(wsError.diagnostic.path).toBe('/<redacted>');
    const { records } = await page({ url: `https://example.test/${cookie}`, headers: { 'content-type': 'application/json', 'set-cookie': `sid=${cookie}; Path=/` }, env: {} });
    expect(records[0].path).toBe('/<redacted>');
    expect(JSON.stringify([discoveryError.diagnostic, wsError.diagnostic, ...records])).not.toContain(cookie);
  });

  it('retains custom environment redaction when WebSocket construction fails', async () => {
    const secret = 'owned-constructor-secret';
    const error = await connect(`ws://example.test/${secret}#invalid`, { env: { OPAQUE_UNUSED_SOURCE: secret } }).catch(error => error);
    expect(error.diagnostic.reason).toBe('invalid-websocket-url');
    expect(JSON.stringify(error.diagnostic)).not.toContain(secret);
  });

  it('masks long known secrets before pathname truncation and case-folded host credentials', () => {
    const secret = 'private-opaque-'.repeat(800);
    const env = { OPAQUE_UNUSED_SOURCE: secret };
    const value = diagnostics.browserDiagnostic({ stage: 'page-navigation', url: `https://example.test/missing/${secret}`, endpoint: 'http://localhost:1', env });
    expect(JSON.stringify(value)).not.toContain(secret.slice(0, 256));
    const hostSecret = 'PrivateOpaqueHost';
    const host = diagnostics.browserDiagnostic({ stage: 'page-navigation', url: `https://${hostSecret}.example.test/missing`, endpoint: `http://${hostSecret}.example.test`, env: { OPAQUE_UNUSED_SOURCE: hostSecret } });
    expect(host.url).toContain('<redacted-host>'); expect(host.endpoint).toContain('<redacted-host>');
    expect(JSON.stringify(host).toLowerCase()).not.toContain(hostSecret.toLowerCase());
  });

  it('fails closed for unknown bare strings, injected status text, HTML and non-error structures', () => {
    const summary = diagnostics.safeErrorResponse({ status: 404, statusText: 'unknown-unlabelled-secret', headers: { 'content-type': 'application/json' },
      body: '{"message":"unknown-unlabelled-secret","reason":"another-opaque-secret","code":"opaque-secret-code","type":"private-type","status":404}', env: {} });
    expect(summary.body.fields).toEqual({ status: 404 });
    expect(JSON.stringify(summary)).not.toMatch(/unknown-unlabelled-secret|another-opaque-secret|opaque-secret-code|private-type/);
    const mismatch = diagnostics.safeErrorResponse({ status: 404, headers: { 'content-type': 'application/json' },
      url: 'https://example.test/actual', body: '{"message":"Cannot GET /unknown-unlabelled-secret"}', env: {} });
    expect(mismatch.body.omittedReason).toBeTypeOf('string');
    expect(JSON.stringify(mismatch)).not.toContain('unknown-unlabelled-secret');
    for (const body of ['<html><body>private-password</body></html>', '{"message":"<html>private-password</html>"}', '["private-password"]']) {
      const value = diagnostics.safeErrorResponse({ status: 404, headers: { 'content-type': 'application/json' }, body, env: {} });
      expect(value.body.omittedReason).toBeTypeOf('string');
      expect(JSON.stringify(value)).not.toContain('private-password');
    }
  });

  it('does not authorize a known numeric credential through JSON code or status', () => {
    for (const [key, value] of [['code', 273849], ['status', 404]]) {
      const summary = diagnostics.safeErrorResponse({ status: 404, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: value }), env: { OPAQUE_UNUSED_SOURCE: String(value) } });
      expect(summary.body.fields?.[key]).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain(String(value));
    }
    const unknown = diagnostics.safeErrorResponse({ status: 404, headers: { 'content-type': 'application/json' },
      body: '{"code":273849}', env: {} });
    expect(unknown.body.omittedReason).toBe('no-safe-error-fields');
  });

  it.each(['text/html', 'application/octet-stream'])('omits unsafe type %s without echoing its body', async contentType => {
    const error = await discovery('private-response-body', { 'Content-Type': contentType });
    expect(error.diagnostic.response.body.omittedReason).toBeTypeOf('string');
    expect(JSON.stringify(error.diagnostic)).not.toContain('private-response-body');
  });

  it('bounds oversize and slow HTTP bodies without changing the observed status', async () => {
    const large = await discovery('x'.repeat(8192));
    expect(large.diagnostic.response.body.omittedReason).toBe('body-too-large');
    const s = await server((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.flushHeaders(); });
    const started = Date.now();
    const slow = await diagnostics.discoverCdp({ endpoint: s.endpoint, env: {} }).catch(error => error);
    expect(slow.diagnostic.status).toBe(404);
    expect(slow.diagnostic.response.body.omittedReason).toBe('body-timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('retains a real bounded WebSocket upgrade rejection body', async () => {
    const s = await server((_req, res) => res.end());
    s.http.on('upgrade', (_req, socket) => {
      const body = '{"error":{"code":404,"message":"Not Found"},"token":"private-upgrade"}';
      socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nSet-Cookie: session=private-cookie\r\n\r\n${body}`);
    });
    const error = await connect(s.endpoint.replace('http:', 'ws:'), { env: {} }).catch(error => error);
    expect(error.diagnostic.response.body.fields).toEqual({ code: 404, message: 'Not Found' });
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/private-upgrade|private-cookie/);
  });

  it('reads an actual small completed page error using only bounded read-only CDP commands', async () => {
    const { records, calls } = await page();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stage: 'page-navigation', response: { body: { kind: 'json-error', fields: { code: 404, message: 'Not Found' } } } });
    expect(calls.filter(value => value === 'Network.getResponseBody')).toHaveLength(1);
    expect(calls.every(value => ['Target.setDiscoverTargets', 'Target.getTargets', 'Target.attachToTarget', 'Network.enable', 'Network.getResponseBody'].includes(value))).toBe(true);
  });

  it.each([{ encodedLength: 8192, reason: 'body-too-large' }, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, reason: 'encoded-body' }])(
    'does not request an unsafe page body ($reason)', async ({ reason, ...options }) => {
      const { records, calls } = await page(options);
      expect(records[0].response.body.omittedReason).toBe(reason);
      expect(calls).not.toContain('Network.getResponseBody');
    });

  it('caps decoded and transport-size page bodies, preserving a real response summary on observer loss', async () => {
    const decoded = await page({ body: Buffer.from('x'.repeat(8192)).toString('base64'), base64Encoded: true });
    expect(decoded.records[0].response.body.omittedReason).toBe('body-too-large');
    const oversized = await page({ body: 'x'.repeat(100000) });
    expect(oversized.records.some(value => value.stage === 'page-navigation' && value.response.body.omittedReason)).toBe(true);
    expect(JSON.stringify(oversized.records).length).toBeLessThan(5000);
  });

  it('bounds page body reads by count and time and ignores duplicate finish events', async () => {
    const many = await page({ count: 12, duplicateFinished: true });
    expect(many.calls.filter(value => value === 'Network.getResponseBody')).toHaveLength(8);
    expect(many.records).toHaveLength(8);
    const timeout = await page({ bodyTimeout: true });
    expect(timeout.records[0].response.body.omittedReason).toBe('body-unavailable-or-timeout');
  });

  it.each(['Network.loadingFailed', 'Target.detachedFromTarget'])('preserves response metadata when %s prevents a body read', async terminal => {
    const { records, calls } = await page({ terminal });
    expect(records[0]).toMatchObject({ stage: 'page-navigation', status: 404,
      response: { body: { omittedReason: terminal === 'Network.loadingFailed' ? 'loading-failed' : 'target-detached' } } });
    expect(calls).not.toContain('Network.getResponseBody');
  });
});
