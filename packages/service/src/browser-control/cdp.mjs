/** Private CDP transport for diagnostics and disposable browser checks. */
import WebSocket from 'ws';
import { browserDiagnostic, BrowserDiagnosticError } from './diagnostics.mjs';
export async function connect(url, { endpoint = url, endpointSource = 'explicit-websocket', onEvent = () => {}, observation = 'request', timeoutMs = 5000 } = {}) {
  // Never follow an upgrade redirect to a different endpoint.
  let ws;
  try { ws = new WebSocket(url, { followRedirects: false }); }
  catch {
    throw new BrowserDiagnosticError(browserDiagnostic({ stage: 'websocket-attach', url, endpoint, endpointSource, reason: 'invalid-websocket-url', observation }));
  }
  let sequence = 0;
  const pending = new Map();
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  await new Promise((resolve, reject) => {
    const fail = (status, reason) => {
      clearTimeout(timer);
      reject(new BrowserDiagnosticError(browserDiagnostic({ stage: 'websocket-attach', url, endpoint, endpointSource, status, reason, observation })));
      ws.terminate();
    };
    const timer = setTimeout(() => fail(undefined, 'connect-timeout'), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => fail(undefined, 'connect-error'), { once: true });
    ws.once('unexpected-response', (_request, response) => {
      response.destroy();
      fail(response.statusCode, 'http-upgrade-rejected');
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
    call(method, params = {}, sessionId) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP unavailable'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP response timeout; outcome may be unknown')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async close() { ws.terminate(); await closed; },
  };
}
