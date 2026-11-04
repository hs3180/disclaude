import { safeLocation, knownSecrets, readErrorResponse } from './response-summary.mjs';
export { safeLocation, safeErrorResponse } from './response-summary.mjs';
// #5352: an HTTP 404 can surface from three different phases, and each phase
// needs a different recovery action. Stage + failing path already record the
// provenance; the remedy pairs them with the one action that fits THAT stage
// so an agent can self-recover instead of blindly restarting the service.
// Keep texts free of credential-bearing content: they are embedded verbatim
// in every browser-diagnostic record.
const HTTP_ERROR_REMEDIES = {
    'http-discovery': 'CDP discovery request failed with an HTTP error: the endpoint did not serve the DevTools discovery route. Verify the configured Chromium CDP endpoint (installed chromium-cdp.json or BU_CDP_URL) points at the browser remote-debugging address/port and Chromium is running; fix the endpoint or restart Chromium, then retry the browser command.',
    'websocket-attach': 'CDP WebSocket attach was rejected with an HTTP error: the browser most likely restarted, so the recorded WebSocket browser id is stale. Re-run discovery to refresh the WebSocket URL (retry the browser command, or run browser-use --reload to rebuild the runtime manifest against the current browser); restarting the whole Disclaude service is not required.',
    'page-navigation': 'The page itself answered with an HTTP error: the CDP connection is healthy, so do not touch the browser or the service. Check the target URL (typo, moved or removed page) and navigate to a corrected URL.',
};
export function browserDiagnostic({ stage, url, endpoint, endpointSource = 'unknown', method = 'GET', status, reason, observation = 'request', response, env = process.env, headers }) {
    const secrets = knownSecrets(env, [url, endpoint], headers);
    return { type: 'browser-diagnostic', stage, observation, method, ...safeLocation(url, secrets),
        endpoint: safeLocation(endpoint, secrets).url, endpointSource,
        ...(Number.isFinite(status) ? { status } : {}), ...(reason ? { reason } : {}),
        ...(Number.isFinite(status) && status >= 400 && HTTP_ERROR_REMEDIES[stage] ? { remedy: HTTP_ERROR_REMEDIES[stage] } : {}),
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
    try {
        response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    }
    catch {
        throw fail(undefined, 'request-failed');
    }
    if (!response.ok) {
        const summary = await readErrorResponse(response, { url, endpoint, env });
        throw fail(response.status, 'http-error', summary, response.headers);
    }
    try {
        const version = await response.json();
        const websocket = new URL(version.webSocketDebuggerUrl);
        const browserId = /^\/devtools\/browser\/([^/]+)$/.exec(websocket.pathname)?.[1];
        if (!['ws:', 'wss:'].includes(websocket.protocol) || !browserId)
            throw new Error();
        return { websocket, browserId };
    }
    catch {
        throw fail(response.status, 'invalid-browser-identity');
    }
}
