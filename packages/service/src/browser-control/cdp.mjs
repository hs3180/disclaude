/** Private CDP transport for diagnostics and disposable browser checks. */
import WebSocket from 'ws';
import { browserDiagnostic, BrowserDiagnosticError } from './diagnostics.mjs';
import { readErrorResponse } from './response-summary.mjs';
export async function connect(url, { endpoint = url, endpointSource = 'explicit-websocket', onEvent = () => {}, observation = 'request', timeoutMs = 5000, maxPayloadBytes, env = process.env } = {}) {
  // Never follow an upgrade redirect to a different endpoint.
  let ws;
  try { ws = new WebSocket(url, { followRedirects: false, ...(maxPayloadBytes ? { maxPayload: maxPayloadBytes } : {}) }); }
  catch {
    throw new BrowserDiagnosticError(browserDiagnostic({ stage: 'websocket-attach', url, endpoint, endpointSource, reason: 'invalid-websocket-url', observation, env }));
  }
  let sequence = 0;
  const pending = new Map();
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  await new Promise((resolve, reject) => {
    let settled = false, upgradeResponse = false;
    const fail = (status, reason, response, headers) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      reject(new BrowserDiagnosticError(browserDiagnostic({ stage: 'websocket-attach', url, endpoint, endpointSource, status, reason, observation, response, env, headers })));
      ws.terminate();
    };
    const timer = setTimeout(() => fail(undefined, 'connect-timeout'), timeoutMs);
    ws.addEventListener('open', () => { settled = true; clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { if (!upgradeResponse) fail(undefined, 'connect-error'); });
    ws.once('unexpected-response', async (_request, response) => {
      upgradeResponse = true; clearTimeout(timer);
      const summary = await readErrorResponse(response, { url, endpoint, env });
      fail(response.statusCode, 'http-upgrade-rejected', summary, response.headers);
    });
  });
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method) {
      try { onEvent(message); } catch { /* Observability must not break the transport. */ }
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP disconnected; outcome may be unknown')); }
    pending.clear();
  });
  return {
    ws, closed,
    call(method, params = {}, sessionId, { timeoutMs: callTimeoutMs = 5000 } = {}) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP unavailable'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP response timeout; outcome may be unknown')); }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async close() { ws.terminate(); await closed; },
  };
}
