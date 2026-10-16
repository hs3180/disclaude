/** Browser diagnostics contain routing metadata, never response bodies or headers. */
export function safeLocation(value) {
  if (!value) return { url: '<unknown>', path: '<unknown>' };
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return { url: '<non-http-url>', path: '<non-http-url>' };
    // Queries, fragments and userinfo may contain credentials. Preserve the
    // pathname needed to diagnose a bad route, but redact labelled path tokens.
    const path = url.pathname.replace(/\/(token|secret|password|api[-_]?key|authorization)\/[^/]+/giu, '/$1/<redacted>').slice(0, 2048);
    return { url: `${url.protocol}//${url.host}${path}`, path };
  } catch { return { url: '<invalid-url>', path: '<invalid-url>' }; }
}

export function browserDiagnostic({ stage, url, endpoint, endpointSource = 'unknown', method = 'GET', status, reason, observation = 'request' }) {
  return { type: 'browser-diagnostic', stage, observation, method, ...safeLocation(url),
    endpoint: safeLocation(endpoint).url, endpointSource,
    ...(Number.isFinite(status) ? { status } : {}), ...(reason ? { reason } : {}),
    response: '<body and headers omitted: may contain credentials or private page content>' };
}

export class BrowserDiagnosticError extends Error {
  constructor(diagnostic) {
    super(`Browser ${diagnostic.stage} failed: ${JSON.stringify(diagnostic)}`);
    this.name = 'BrowserDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

export async function discoverCdp({ endpoint, endpointSource, fetchImpl = globalThis.fetch }) {
  const url = `${endpoint}/json/version`;
  const fail = (status, reason) => new BrowserDiagnosticError(browserDiagnostic({
    stage: 'http-discovery', url, endpoint, endpointSource, status, reason,
  }));
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) }); }
  catch { throw fail(undefined, 'request-failed'); }
  if (!response.ok) {
    // Do not read a potentially unbounded or secret-bearing error body.
    await response.body?.cancel().catch(() => {});
    throw fail(response.status, 'http-error');
  }
  try {
    const version = await response.json();
    const websocket = new URL(version.webSocketDebuggerUrl);
    const browserId = /^\/devtools\/browser\/([^/]+)$/.exec(websocket.pathname)?.[1];
    if (!['ws:', 'wss:'].includes(websocket.protocol) || !browserId) throw new Error();
    return { websocket, browserId };
  } catch { throw fail(response.status, 'invalid-browser-identity'); }
}
