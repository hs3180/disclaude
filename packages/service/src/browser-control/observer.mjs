import { connect } from './cdp.mjs';
import { browserDiagnostic } from './diagnostics.mjs';
import { ERROR_BODY_BYTES, ERROR_BODY_TIMEOUT_MS, responseBodyEligibility, safeErrorResponse } from './response-summary.mjs';

/** Observe HTTP error responses without intercepting or replaying browser work.
 * This connection lives only for one lock-held invocation. A target may start
 * loading before Network.enable completes; absent request metadata stays unknown.
 */
export async function observeBrowser({ websocket, endpoint, endpointSource, onDiagnostic, env = process.env }) {
  const context = { endpoint, endpointSource, observation: 'diagnostic-observer' };
  const targets = new Set(), sessions = new Map(), requests = new Map(), setup = new Set();
  const responses = new Map();
  let responseCount = 0;
  let client, stopped = false, records = 0, timer;
  const report = record => {
    if (!stopped && records++ < 8) {
      try { onDiagnostic(record); } catch { /* Diagnostic sinks cannot break browser work. */ }
    }
  };
  const complete = (key, body, omittedReason) => {
    const item = responses.get(key); if (!item) return;
    responses.delete(key); clearTimeout(item.timer);
    const response = safeErrorResponse({ ...item, endpoint, env, body, omittedReason });
    report({ ...browserDiagnostic({ ...context, ...item, env, response, stage: 'page-navigation', reason: 'document-http-error' }), targetId: item.targetId });
  };
  const completeAll = reason => { for (const key of [...responses.keys()]) complete(key, undefined, reason); };
  const attach = target => {
    if (stopped || target?.type !== 'page' || typeof target.targetId !== 'string' || !target.targetId ||
        targets.has(target.targetId) || targets.size >= 16) return;
    targets.add(target.targetId);
    const task = (async () => {
      const { sessionId } = await client.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Missing target session');
      sessions.set(sessionId, target.targetId);
      if (!stopped) await client.call('Network.enable', {}, sessionId);
    })().catch(() => {
      report(browserDiagnostic({ ...context, env, stage: 'unknown', url: websocket, method: 'CDP Target.attachToTarget/Network.enable', reason: 'page-observation-unavailable' }));
    });
    setup.add(task); void task.finally(() => setup.delete(task));
  };
  try {
    client = await connect(websocket, { ...context, env, timeoutMs: 1000, maxPayloadBytes: 65536, onEvent: event => {
      if (stopped) return;
      const params = event.params;
      if (!params || typeof params !== 'object') return;
      if (event.method === 'Target.targetCreated') { attach(params.targetInfo); return; }
      if (event.method === 'Target.detachedFromTarget') {
        sessions.delete(params.sessionId);
        for (const key of requests.keys()) if (key.startsWith(`${params.sessionId}:`)) requests.delete(key);
        for (const key of responses.keys()) if (key.startsWith(`${params.sessionId}:`)) complete(key, undefined, 'target-detached');
        return;
      }
      if (!sessions.has(event.sessionId) || typeof params.requestId !== 'string') return;
      const key = `${event.sessionId}:${params.requestId}`;
      if (event.method === 'Network.requestWillBeSent' && params.type === 'Document') {
        if (requests.size >= 256) requests.delete(requests.keys().next().value);
        const method = params.request?.method;
        requests.set(key, /^[A-Z]{1,20}$/u.test(method) ? method : 'unknown');
      } else if (event.method === 'Network.responseReceived' && params.type === 'Document') {
        const { response } = params;
        if (Number.isFinite(response?.status) && response.status >= 400 && typeof response.url === 'string' && responseCount < 8 && !responses.has(key)) {
          responseCount++;
          const headers = response.headers && typeof response.headers === 'object' ? { ...response.headers } : {};
          if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type') && typeof response.mimeType === 'string') headers['content-type'] = response.mimeType;
          responses.set(key, { url: response.url, status: response.status, statusText: response.statusText, headers,
            method: requests.get(key) || 'unknown', targetId: sessions.get(event.sessionId) || 'unknown',
            timer: setTimeout(() => complete(key, undefined, 'body-not-finished'), ERROR_BODY_TIMEOUT_MS) });
          const reason = responseBodyEligibility(headers); if (reason) complete(key, undefined, reason);
        }
      } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)) {
        requests.delete(key);
        const item = responses.get(key); if (!item) return;
        if (event.method === 'Network.loadingFailed') { complete(key, undefined, 'loading-failed'); return; }
        if (item.reading) return;
        clearTimeout(item.timer);
        if (!Number.isSafeInteger(params.encodedDataLength) || params.encodedDataLength < 0) { complete(key, undefined, 'body-size-unknown'); return; }
        if (params.encodedDataLength > ERROR_BODY_BYTES) { complete(key, undefined, 'body-too-large'); return; }
        item.reading = true;
        // A protocol response is indivisible; the observer's 64 KiB WebSocket
        // maxPayload is the hard memory bound even if encoded length is false.
        void client.call('Network.getResponseBody', { requestId: params.requestId }, event.sessionId, { timeoutMs: ERROR_BODY_TIMEOUT_MS })
          .then(result => {
            if (typeof result?.body !== 'string') { complete(key, undefined, 'body-unavailable'); return; }
            if (typeof result.base64Encoded !== 'boolean') { complete(key, undefined, 'invalid-body-encoding'); return; }
            const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
            if (bytes.length > ERROR_BODY_BYTES) complete(key, undefined, 'body-too-large');
            else complete(key, bytes.toString('utf8'));
          }, () => complete(key, undefined, 'body-unavailable-or-timeout'));
      }
    } });
    client.ws.once('close', () => {
      completeAll('observation-disconnected');
      report(browserDiagnostic({ ...context, env, stage: 'unknown', url: websocket, method: 'unknown', reason: 'observation-disconnected' }));
    });
    await Promise.race([
      (async () => {
        await client.call('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await client.call('Target.getTargets');
        if (!Array.isArray(targetInfos)) throw new Error('Missing target list');
        for (const target of targetInfos) attach(target);
        await Promise.all([...setup]);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Observation setup timeout')), 1000); }),
    ]);
    clearTimeout(timer);
    return { async stop() { completeAll('invocation-ended-before-body'); stopped = true; await client.close(); await Promise.all([...setup]); } };
  } catch (error) {
    clearTimeout(timer);
    if (error.diagnostic) report(error.diagnostic);
    else report(browserDiagnostic({ ...context, env, stage: 'unknown', url: websocket, method: 'CDP Target discovery', reason: 'observation-unavailable' }));
    completeAll('observation-unavailable');
    stopped = true;
    await client?.close();
    return { async stop() {} };
  }
}
