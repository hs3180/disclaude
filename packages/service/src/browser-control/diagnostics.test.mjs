import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { browserAgentEnv, resolveBrowserRuntimePath } from '@disclaude/core/browser-runtime';
import { connect } from './cdp.mjs';
import { discoverCdp, safeLocation } from './diagnostics.mjs';
import { observeBrowser } from './observer.mjs';
import { prepareBrowserCommands, browserStatus, resolveCdpConfiguration } from './service.mjs';

const cleanup = [];
beforeAll(() => nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/u));
afterEach(async () => { for (const stop of cleanup.reverse()) await stop(); cleanup.length = 0; });

async function server(handler = (_req, res) => res.end('{}')) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return { http, endpoint: `http://127.0.0.1:${http.address().port}` };
}

async function cdpServer({ rejectUpgrade = false } = {}) {
  const seen = [], sockets = new Set();
  const s = await server();
  const websocket = `${s.endpoint.replace('http:', 'ws:')}/devtools/browser/${randomUUID()}`;
  const wss = new WebSocketServer({ noServer: true });
  cleanup.push(() => { for (const socket of sockets) socket.terminate(); wss.close(); });
  s.http.on('upgrade', (req, socket, head) => {
    seen.push({ method: req.method, path: req.url });
    if (rejectUpgrade) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 28\r\nSet-Cookie: session=secret\r\n\r\n{"token":"upgrade-secret"}');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    sockets.add(ws); ws.once('close', () => sockets.delete(ws));
    ws.on('message', data => {
      const request = JSON.parse(data.toString());
      seen.push(request);
      const result = request.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'page', type: 'page' }] } :
        request.method === 'Target.attachToTarget' ? { sessionId: 'page-session' } : {};
      ws.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const event = (method, params, sessionId = 'page-session') => {
    for (const ws of sockets) ws.send(JSON.stringify({ method, params, sessionId }));
  };
  return { ...s, websocket, seen, sockets, event };
}

function diagnostics(stderr) {
  return stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}

describe('browser HTTP failure provenance', () => {
  it('records an actual discovery 404 with path/source and omits a credential-bearing body', async () => {
    const requests = [];
    const s = await server((req, res) => {
      requests.push({ method: req.method, path: req.url });
      res.writeHead(404, { 'Content-Type': 'application/json', 'Set-Cookie': 'secret-cookie' });
      res.end('{"message":"password=secret-password","token":"secret-token"}');
    });
    const error = await discoverCdp({ endpoint: `${s.endpoint}/proxy`, endpointSource: 'BU_CDP_URL' }).catch(error => error);
    expect(error.diagnostic).toMatchObject({ stage: 'http-discovery', method: 'GET', path: '/proxy/json/version',
      endpointSource: 'BU_CDP_URL', status: 404, reason: 'http-error' });
    expect(requests).toEqual([{ method: 'GET', path: '/proxy/json/version' }]);
    expect(error.message).not.toMatch(/secret-password|secret-token|secret-cookie/);
  });

  it('emits the startup diagnostic before refusing a bad discovery route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-browser-discovery-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'browser-use'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const s = await server((_req, res) => { res.writeHead(404); res.end('secret'); });
    const onEvent = vi.fn();
    await expect(prepareBrowserCommands({ env: { HOME: root, PATH: root, BU_CDP_URL: s.endpoint }, onEvent }))
      .rejects.toMatchObject({ diagnostic: { stage: 'http-discovery', status: 404 } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ stage: 'http-discovery', status: 404 }));
  });

  it('does not follow a discovery redirect or try an alternative discovery route', async () => {
    const requests = [];
    const s = await server((req, res) => {
      requests.push(req.url); res.writeHead(302, { Location: '/other?token=secret' }); res.end();
    });
    const error = await discoverCdp({ endpoint: s.endpoint, endpointSource: 'BU_CDP_URL' }).catch(error => error);
    expect(error.diagnostic).toMatchObject({ stage: 'http-discovery', path: '/json/version', reason: 'request-failed' });
    expect(requests).toEqual(['/json/version']);
    expect(error.message).not.toContain('secret');
  });

  it('identifies the actual rejected WebSocket GET route without leaking query, userinfo or response', async () => {
    const s = await cdpServer({ rejectUpgrade: true });
    const url = `${s.websocket}?token=secret-query`;
    const error = await connect(url, { endpoint: `http://user:secret-password@127.0.0.1/`, endpointSource: 'installed-chromium-config' }).catch(error => error);
    expect(error.diagnostic).toMatchObject({ stage: 'websocket-attach', status: 404, method: 'GET',
      path: new URL(s.websocket).pathname, endpointSource: 'installed-chromium-config' });
    expect(s.seen).toEqual([{ method: 'GET', path: `${new URL(s.websocket).pathname}?token=secret-query` }]);
    expect(error.message).not.toMatch(/secret-query|secret-fragment|secret-password|upgrade-secret|session=secret/);
    expect(safeLocation('https://u:p@example.test/token/abc/path?key=abc#secret'))
      .toEqual({ url: 'https://example.test/token/<redacted>/path', path: '/token/<redacted>/path' });
  });

  it('observes document 404 independently from successful attach and retains unknown methods', async () => {
    const s = await cdpServer(), records = [];
    const observer = await observeBrowser({ websocket: s.websocket, endpoint: s.endpoint, endpointSource: 'BU_CDP_URL', onDiagnostic: record => records.push(record) });
    cleanup.push(() => observer.stop());
    s.event('Network.requestWillBeSent', { requestId: 'post', type: 'Document', request: { method: 'POST', url: 'https://example.test/missing' } });
    for (let i = 0; i < 20; i++) s.event('Network.responseReceived', { requestId: i ? 'unobserved' : 'post', type: 'Document',
      response: { status: 404, url: 'https://user:secret@example.test/missing?token=secret-query#secret-fragment', headers: { 'Set-Cookie': 'secret-cookie' } } });
    await vi.waitFor(() => expect(records).toHaveLength(8));
    expect(records[0]).toMatchObject({ stage: 'page-navigation', method: 'POST', status: 404, path: '/missing', endpointSource: 'BU_CDP_URL', targetId: 'page' });
    expect(records[1].method).toBe('unknown');
    expect(JSON.stringify(records)).not.toMatch(/secret|websocket-attach|http-discovery/);
    expect(s.seen.filter(item => item.method).map(item => item.method)).toEqual([
      'GET', 'Target.setDiscoverTargets', 'Target.getTargets', 'Target.attachToTarget', 'Network.enable',
    ]);
    await observer.stop();
    await vi.waitFor(() => expect(s.sockets.size).toBe(0));
  });

  it('reports unavailable observation without selecting another endpoint or retrying', async () => {
    const s = await cdpServer({ rejectUpgrade: true }), records = [];
    const observer = await observeBrowser({ websocket: s.websocket, endpoint: s.endpoint, endpointSource: 'BU_CDP_URL', onDiagnostic: record => records.push(record) });
    await observer.stop();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stage: 'websocket-attach', observation: 'diagnostic-observer', status: 404 });
    expect(s.seen).toEqual([{ method: 'GET', path: new URL(s.websocket).pathname }]);
  });

  it('ignores malformed/detached events and isolates a failing diagnostic sink', async () => {
    const s = await cdpServer();
    const sink = vi.fn(() => { throw new Error('sink failed'); });
    const observer = await observeBrowser({ websocket: s.websocket, endpoint: s.endpoint, onDiagnostic: sink });
    cleanup.push(() => observer.stop());
    for (const ws of s.sockets) { ws.send('null'); ws.send('invalid JSON'); }
    s.event('Target.targetCreated');
    s.event('Target.targetCreated', { targetInfo: { type: 'page' } });
    s.event('Network.requestWillBeSent', { requestId: 'missing-request', type: 'Document' });
    s.event('Network.responseReceived');
    s.event('Network.responseReceived', { requestId: 'missing-response', type: 'Document' });
    s.event('Network.responseReceived', { requestId: 'missing-status', type: 'Document', response: {} });
    s.event('Network.responseReceived', { requestId: 'no-session', type: 'Document', response: { status: 404, url: 'https://example.test/' } }, 'unknown-session');
    // A valid response still reaches the failing sink, proving malformed input
    // did not kill the event listener or reject the observation connection.
    s.event('Network.responseReceived', { requestId: 'valid', type: 'Document', response: { status: 404, url: 'https://example.test/' } });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    s.event('Target.detachedFromTarget', { sessionId: 'page-session' });
    s.event('Network.responseReceived', { requestId: 'detached', type: 'Document', response: { status: 404, url: 'https://example.test/' } });
    const client = await connect(s.websocket, { onEvent: () => { throw new Error('callback failed'); } });
    cleanup.push(() => client.close());
    s.event('test.event', {});
    await expect(client.call('Browser.getVersion')).resolves.toEqual({});
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('keeps a scripted CLI stdout/exit and reports a page 404 as a page response', async () => {
    const s = await cdpServer();
    const root = mkdtempSync(join(tmpdir(), 'dc-browser-404-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'upstream'); mkdirSync(bin);
    writeFileSync(join(bin, 'browser-use'), `#!${process.execPath}\nsetTimeout(() => { process.stdout.write('original result'); process.exit(0); }, 300);\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, BU_CDP_URL: s.endpoint,
      DISCLAUDE_CONFIG_PATH: join(root, 'config.json'), DISCLAUDE_CHROMIUM_CONFIG: join(root, 'missing.json') };
    const runtime = await prepareBrowserCommands({ env, fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ webSocketDebuggerUrl: s.websocket }))) });
    const path = resolveBrowserRuntimePath(env), data = JSON.parse(readFileSync(path, 'utf8'));
    cleanup.push(() => rmSync(data.directory, { recursive: true, force: true }));
    cleanup.push(() => runtime.stop());
    expect(resolveCdpConfiguration(env)).toEqual({ endpoint: s.endpoint, endpointSource: 'BU_CDP_URL' });
    const child = spawn(join(dirname(path), 'bin/browser-use'), [], { cwd: root, env: { ...env, ...browserAgentEnv(env) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const result = new Promise(resolve => child.once('close', code => resolve(code)));
    cleanup.push(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    child.stdin.end('upstream script');
    await vi.waitFor(() => expect(s.seen.some(item => item.method === 'Network.enable')).toBe(true));
    s.event('Network.requestWillBeSent', { requestId: 'nav', type: 'Document', request: { method: 'GET' } });
    s.event('Network.responseReceived', { requestId: 'nav', type: 'Document', response: { status: 404, url: 'https://example.test/not-found?private=secret' } });
    expect(await result).toBe(0); expect(stdout).toBe('original result');
    const [record] = diagnostics(stderr);
    expect(record).toMatchObject({ stage: 'page-navigation', status: 404, method: 'GET', path: '/not-found', observation: 'diagnostic-observer' });
    expect(record.invocationId).toBeTruthy();
    expect(browserStatus(path)).toMatchObject({ state: 'idle', lastDiagnostic: record });
    expect(stderr).not.toMatch(/CDP.*failed|secret/);
    await vi.waitFor(() => expect(s.sockets.size).toBe(0));
  });
});
