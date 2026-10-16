export class JupyterDiagnosticError extends Error {
    diagnostic;
    constructor(diagnostic) {
        super(diagnostic.message);
        this.diagnostic = diagnostic;
        this.name = 'JupyterDiagnosticError';
    }
}
export function redactJupyterText(text, secrets = [], limit = 800) {
    let safe = text;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
        for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
            safe = safe.split(form).join('[redacted]');
        }
    }
    return safe
        .replace(/\b(?:Bearer|token)\s+[^\s"'<>;,]+/gi, '[redacted authorization]')
        .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization|cookie|_xsrf)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}<>]+)/gi, '$1[redacted]')
        .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
        try {
            const url = new URL(value);
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.href;
        }
        catch {
            return '[URL omitted]';
        }
    })
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g, ' ')
        .slice(0, limit);
}
/** Keep concise server error fields; omit HTML forms, cookies and traceback dumps. */
export function jupyterServerBody(raw, secrets) {
    let excerpt = raw;
    if (/^\s*</.test(raw)) {
        return '[HTML response omitted]';
    }
    try {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            const record = data;
            const nested = record.error && typeof record.error === 'object' ? record.error : {};
            const fields = Object.fromEntries(['message', 'reason', 'error', 'code'].flatMap(key => {
                const value = record[key] ?? nested[key];
                return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
                    ? [[key, typeof value === 'string' ? redactJupyterText(value, secrets, 8000) : value]] : [];
            }));
            excerpt = Object.keys(fields).length ? JSON.stringify(fields) : '[JSON error response omitted]';
        }
        else {
            excerpt = '[Non-object JSON response omitted]';
        }
    }
    catch { /* Plain-text server errors are bounded and scrubbed below. */ }
    return redactJupyterText(excerpt, secrets);
}
export function jupyterNetworkDiagnostic(error) {
    const seen = new Set();
    let current = error;
    let code = '';
    let timeout = false;
    for (let i = 0; i < 5 && current && typeof current === 'object' && !seen.has(current); i++) {
        seen.add(current);
        const record = current;
        const { code: currentCode } = record;
        if (typeof currentCode === 'string') {
            code = currentCode;
        }
        timeout ||= record.name === 'TimeoutError' || record.name === 'AbortError';
        current = record.cause;
    }
    const dns = ['ENOTFOUND', 'EAI_AGAIN'].includes(code);
    return new JupyterDiagnosticError({ layer: dns ? 'dns' : 'tcp', code: dns ? 'dns_lookup_failed' : timeout ? 'request_timeout' : 'connection_failed',
        message: dns ? 'Jupyter hostname could not be resolved' : timeout ? 'Jupyter connection timed out' : 'Jupyter request outcome could not be verified',
        phase: 'connection', outcome: 'unknown',
        hint: 'Check the configured remote endpoint and network. Inspect the original run before retrying an uncertain execution.' });
}
export function jupyterDiagnostic(error, fallback = 'unknown') {
    if (error instanceof JupyterDiagnosticError) {
        return { ...error.diagnostic };
    }
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(code)) {
        return { layer: 'local', code: 'local_file_unavailable', message: 'Jupyter local input, Project directory or command lock is unavailable',
            hint: 'Check local paths, file permissions and the Project lock. Preserve the original remote run status before retrying.', outcome: 'unknown' };
    }
    return { layer: fallback, code: fallback === 'schema' ? 'invalid_input' : 'unclassified_failure',
        message: fallback === 'schema' ? 'Jupyter input or option is invalid' : 'Jupyter operation failed without a verified diagnostic',
        hint: fallback === 'schema' ? 'Read jupyter tools and command help; validate the local input file.'
            : 'Check the original Project reference and run status. Do not replay an unknown execution.', outcome: 'unknown' };
}
export function jupyterExitCode(layer) {
    return { unknown: 1, schema: 2, auth: 3, dns: 4, tcp: 5, http: 6, cas: 7, local: 8 }[layer];
}
export function jupyterHashConflict(expected, actual) {
    const hint = 'Re-describe or read-cell, take the latest full sourceHash, review the changed source, then decide whether to submit a new operation.';
    return { state: 'conflict', sourceHash: actual, expected, actual, hint,
        diagnostic: { layer: 'cas', code: 'source_hash_conflict', message: 'Notebook sourceHash differs from the expected source',
            expected, actual, hint, outcome: 'not-submitted' } };
}
