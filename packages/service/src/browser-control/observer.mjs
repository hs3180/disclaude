import { connect } from './cdp.mjs';
import { browserDiagnostic } from './diagnostics.mjs';

/** Observe HTTP error responses without intercepting or replaying browser work.
 * This connection lives only for one lock-held invocation. A target may start
 * loading before Network.enable completes; absent request metadata stays unknown.
 */
export async function observeBrowser({ websocket, endpoint, endpointSource, onDiagnostic }) {
  const context = { endpoint, endpointSource, observation: 'diagnostic-observer' };
  const targets = new Set(), sessions = new Map(), requests = new Map(), setup = new Set();
  let client, stopped = false, records = 0, timer;
  const report = record => {
    if (!stopped && records++ < 8) {
      try { onDiagnostic(record); } catch { /* Diagnostic sinks cannot break browser work. */ }
    }
  };
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
      report(browserDiagnostic({ ...context, stage: 'unknown', url: websocket, method: 'CDP Target.attachToTarget/Network.enable', reason: 'page-observation-unavailable' }));
    });
    setup.add(task); void task.finally(() => setup.delete(task));
  };
  try {
    client = await connect(websocket, { ...context, timeoutMs: 1000, onEvent: event => {
      if (stopped) return;
      const params = event.params;
      if (!params || typeof params !== 'object') return;
      if (event.method === 'Target.targetCreated') { attach(params.targetInfo); return; }
      if (event.method === 'Target.detachedFromTarget') {
        sessions.delete(params.sessionId);
        for (const key of requests.keys()) if (key.startsWith(`${params.sessionId}:`)) requests.delete(key);
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
        if (Number.isFinite(response?.status) && response.status >= 400 && typeof response.url === 'string') report({ ...browserDiagnostic({ ...context, stage: 'page-navigation', url: response.url,
          method: requests.get(key) || 'unknown', status: response.status, reason: 'document-http-error' }), targetId: sessions.get(event.sessionId) || 'unknown' });
      } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)) requests.delete(key);
    } });
    client.ws.once('close', () => report(browserDiagnostic({ ...context, stage: 'unknown', url: websocket,
      method: 'unknown', reason: 'observation-disconnected' })));
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
    return { async stop() { stopped = true; await client.close(); await Promise.all([...setup]); } };
  } catch (error) {
    clearTimeout(timer);
    if (error.diagnostic) report(error.diagnostic);
    else report(browserDiagnostic({ ...context, stage: 'unknown', url: websocket, method: 'CDP Target discovery', reason: 'observation-unavailable' }));
    stopped = true;
    await client?.close();
    return { async stop() {} };
  }
}
