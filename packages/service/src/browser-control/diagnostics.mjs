import { safeLocation, knownSecrets, readErrorResponse } from './response-summary.mjs';
export { safeLocation, safeErrorResponse } from './response-summary.mjs';

export function browserDiagnostic({ stage, url, endpoint, endpointSource = 'unknown', method = 'GET', status, reason, observation = 'request', response, env = process.env, headers }) {
  const secrets = knownSecrets(env, [url, endpoint], headers);
  return { type: 'browser-diagnostic', stage, observation, method, ...safeLocation(url, secrets),
    endpoint: safeLocation(endpoint, secrets).url, endpointSource,
    ...(Number.isFinite(status) ? { status } : {}), ...(reason ? { reason } : {}),
    response: response ?? { body: { omittedReason: 'response-unavailable' } } };
}

export class BrowserDiagnosticError extends Error {
  constructor(diagnostic) {
    super(`Browser ${diagnostic.stage} failed: ${JSON.stringify(diagnostic)}`);
    this.name = 'BrowserDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

export async function discoverCdp({ endpoint, endpointSource, fetchImpl = globalThis.fetch, env = process.env }) {
  const url = `${endpoint}/json/version`;
  const fail = (status, reason, response, headers) => new BrowserDiagnosticError(browserDiagnostic({
    stage: 'http-discovery', url, endpoint, endpointSource, status, reason, response, env, headers,
  }));
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) }); }
  catch { throw fail(undefined, 'request-failed'); }
  if (!response.ok) {
    const summary = await readErrorResponse(response, { url, endpoint, env });
    throw fail(response.status, 'http-error', summary, response.headers);
  }
  try {
    const version = await response.json();
    const websocket = new URL(version.webSocketDebuggerUrl);
    const browserId = /^\/devtools\/browser\/([^/]+)$/.exec(websocket.pathname)?.[1];
    if (!['ws:', 'wss:'].includes(websocket.protocol) || !browserId) throw new Error();
    return { websocket, browserId };
  } catch { throw fail(response.status, 'invalid-browser-identity'); }
}
