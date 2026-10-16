import { JupyterDiagnosticError, jupyterNetworkDiagnostic, jupyterServerBody } from './diagnostics.js';
/** Restore only a host-owned jar. No cookie data belongs in a tool descriptor. */
export async function createJupyterCookieJar(serialized) {
    const { CookieJar } = await import('tough-cookie');
    return serialized === undefined
        ? new CookieJar()
        : CookieJar.fromJSON(JSON.stringify(serialized));
}
/** Shared password/cookie transport for remote Jupyter APIs; no local Python. */
export class JupyterHttpConnection {
    httpOptions;
    base;
    timeoutMs;
    maxResponseBytes;
    cookies;
    authenticating;
    diagnosticSecrets = new Set();
    diagnosticCookies = [];
    constructor(httpOptions) {
        this.httpOptions = httpOptions;
        const options = httpOptions;
        this.base = new URL(options.baseUrl);
        if (this.base.username ||
            this.base.password ||
            this.base.search ||
            this.base.hash ||
            (this.base.protocol !== 'https:' &&
                !(this.base.protocol === 'http:' &&
                    (['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname) ||
                        options.allowInsecureHttp === true)))) {
            throw new Error('Jupyter coordinator requires HTTPS, loopback HTTP or explicit host HTTP permission without URL credentials');
        }
        if ((typeof options.authorization === 'function') === (typeof options.password === 'function') ||
            (options.authorization !== undefined && typeof options.authorization !== 'function') ||
            (options.password !== undefined && typeof options.password !== 'function') ||
            (options.allowInsecureHttp !== undefined && typeof options.allowInsecureHttp !== 'boolean')) {
            throw new Error('Choose exactly one host-owned Jupyter authentication mode');
        }
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.maxResponseBytes = options.maxResponseBytes ?? 3_000_000;
        if (!Number.isSafeInteger(this.timeoutMs) ||
            this.timeoutMs < 1 ||
            !Number.isSafeInteger(this.maxResponseBytes) ||
            this.maxResponseBytes < 1) {
            throw new Error('Invalid Jupyter coordinator request limits');
        }
        this.base.pathname = this.base.pathname.replace(/\/?$/, '/');
    }
    cookieJar() {
        this.cookies ??= this.httpOptions.cookieJar
            ? Promise.resolve(this.httpOptions.cookieJar)
            : import('tough-cookie').then(({ CookieJar }) => new CookieJar());
        return this.cookies;
    }
    async secret(resolver) {
        try {
            const value = await resolver();
            if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n]/.test(value)) {
                throw new Error('Invalid secret');
            }
            this.diagnosticSecrets.add(value);
            if (/^(?:token|Bearer)\s+/i.test(value)) {
                this.diagnosticSecrets.add(value.replace(/^\S+\s+/, ''));
            }
            while (this.diagnosticSecrets.size > 8) {
                const oldest = this.diagnosticSecrets.values().next().value;
                if (oldest === undefined) {
                    break;
                }
                this.diagnosticSecrets.delete(oldest);
            }
            return value;
        }
        catch {
            throw new JupyterDiagnosticError({ layer: 'auth', code: 'credentials_unavailable', phase: 'credentials',
                message: 'Jupyter connection authentication is unavailable', hint: 'Resolve the host-owned password/token from environment or the selected private env file.' });
        }
    }
    async send(route, body, loginRedirect = false, method = body ? 'POST' : 'GET') {
        const url = this.url(route);
        const authorization = this.httpOptions.authorization
            ? await this.secret(this.httpOptions.authorization)
            : undefined;
        const cookies = await this.cookieJar();
        const cookie = await cookies.getCookieString(url.href);
        this.diagnosticCookies = [cookie, ...cookie.split(';').map(part => part.slice(part.indexOf('=') + 1).trim())].filter(Boolean);
        if (Buffer.byteLength(cookie) > 16_384) {
            throw new Error('Jupyter session cookie limit exceeded');
        }
        let response;
        const progress = (state, status) => {
            try {
                this.httpOptions.onProgress?.({ phase: 'http', method, state, ...(status === undefined ? {} : { status }) });
            }
            catch { /* Diagnostics cannot change request/execute semantics. */ }
        };
        progress('requested');
        try {
            response = await fetch(url, {
                method,
                headers: {
                    ...(authorization ? { Authorization: authorization } : {}),
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...(this.httpOptions.password
                        ? { Origin: this.base.origin, Referer: this.base.href }
                        : {}),
                    ...(method !== 'GET'
                        ? {
                            'Content-Type': body instanceof URLSearchParams
                                ? 'application/x-www-form-urlencoded'
                                : 'application/json',
                            ...(this.httpOptions.password && !(body instanceof URLSearchParams)
                                ? {
                                    'X-XSRFToken': (await cookies.getCookies(url.href)).find((c) => c.key === '_xsrf')
                                        ?.value ?? '',
                                }
                                : {}),
                        }
                        : {}),
                },
                body: body instanceof URLSearchParams ? body : body ? JSON.stringify(body) : undefined,
                redirect: 'manual',
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (error) {
            // Fetch errors may quote a rejected Authorization value. Keep them host-private.
            progress('failed');
            throw jupyterNetworkDiagnostic(error);
        }
        progress('responded', response.status);
        try {
            const updates = response.headers.getSetCookie();
            if (updates.length > 16 || updates.some((value) => Buffer.byteLength(value) > 8192)) {
                throw new Error('Jupyter session cookie limit exceeded');
            }
            for (const update of updates) {
                await cookies.setCookie(update, url.href, { ignoreError: true });
            }
            if ((await cookies.serialize()).cookies.length > 32) {
                await cookies.removeAllCookies();
                throw new Error('Jupyter session cookie limit exceeded');
            }
        }
        catch (error) {
            await response.body?.cancel();
            throw new Error(error instanceof Error && error.message === 'Jupyter session cookie limit exceeded'
                ? error.message
                : 'Jupyter session cookies cannot be verified');
        }
        if (response.status >= 300 && response.status < 400 && !loginRedirect) {
            await response.body?.cancel();
            throw new JupyterDiagnosticError({ layer: 'http', code: 'redirect_refused', phase: 'http', status: response.status,
                message: 'Jupyter redirect was refused', hint: 'Verify the configured API endpoint and authentication; requests are not redirected automatically.', outcome: 'unknown' });
        }
        return response;
    }
    async responseText(response) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new JupyterDiagnosticError({ layer: 'schema', code: 'response_body_missing', message: 'Jupyter coordinator response body is missing',
                hint: 'Verify the remote API response and server extension.' });
        }
        const chunks = [];
        let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                length += value.byteLength;
                if (length > this.maxResponseBytes) {
                    throw new JupyterDiagnosticError({ layer: 'schema', code: 'response_limit_exceeded', message: 'Jupyter coordinator response limit exceeded',
                        hint: 'Use a bounded output/export request; the response was not accepted.' });
                }
                chunks.push(value);
            }
        }
        catch (error) {
            throw error instanceof JupyterDiagnosticError ? error : jupyterNetworkDiagnostic(error);
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    /** Consume a failed response once and expose only bounded, scrubbed error fields. */
    async responseError(response, phase = 'request') {
        let serverBody;
        try {
            if (this.httpOptions.password) {
                await this.secret(this.httpOptions.password);
            }
            serverBody = jupyterServerBody(await this.responseText(response), [...this.diagnosticSecrets, ...this.diagnosticCookies]);
        }
        catch {
            serverBody = '[Error response unavailable]';
        }
        const auth = response.status === 401 || response.status === 403;
        return new JupyterDiagnosticError({ layer: auth ? 'auth' : 'http', code: auth ? 'authentication_rejected' : 'http_rejected',
            status: response.status, phase, serverBody, message: `Jupyter API returned HTTP ${response.status}`,
            hint: auth ? 'Verify the selected credential source and Jupyter permissions.'
                : 'Inspect the server error and remote path/extension configuration. Verify the original run before retrying an uncertain execution.',
            outcome: auth ? 'rejected' : 'unknown' });
    }
    async authenticate() {
        if (!this.httpOptions.password) {
            return;
        }
        this.authenticating ??= this.loginPassword();
        const pending = this.authenticating;
        try {
            await pending;
        }
        finally {
            if (this.authenticating === pending) {
                this.authenticating = undefined;
            }
        }
    }
    async loginPassword() {
        const resolvePassword = this.httpOptions.password;
        if (!resolvePassword) {
            throw new Error('Jupyter password authentication is unavailable');
        }
        const existing = await this.send('api/status');
        if (existing.ok) {
            await existing.body?.cancel();
            return;
        }
        if (![401, 403].includes(existing.status)) {
            throw await this.responseError(existing, 'authentication-check');
        }
        await existing.body?.cancel();
        const page = await this.send('login');
        if (!page.ok) {
            throw await this.responseError(page, 'password-login-page');
        }
        await page.body?.cancel();
        const loginUrl = new URL('login', this.base);
        const xsrf = (await (await this.cookieJar()).getCookies(loginUrl.href)).find((c) => c.key === '_xsrf')?.value;
        if (!xsrf || xsrf.length > 8192 || /[\r\n]/.test(xsrf)) {
            throw new Error('Jupyter password login token is unavailable');
        }
        const password = await this.secret(resolvePassword);
        const result = await this.send('login', new URLSearchParams({ _xsrf: xsrf, password, next: this.base.pathname }), true);
        await result.body?.cancel();
        const destination = result.headers.get('Location');
        if (![302, 303].includes(result.status) || !destination) {
            throw new JupyterDiagnosticError({ layer: 'auth', code: 'password_login_failed', status: result.status,
                message: 'Jupyter password login failed', hint: 'Verify the selected password and remote Jupyter authentication settings.' });
        }
        let redirect;
        try {
            redirect = new URL(destination, loginUrl);
        }
        catch {
            throw new Error('Jupyter password login redirect was refused');
        }
        if (redirect.origin !== this.base.origin ||
            redirect.username ||
            redirect.password ||
            !redirect.pathname.startsWith(this.base.pathname)) {
            throw new Error('Jupyter password login redirect was refused');
        }
        // Verify the cookie with a safe read. Never follow a redirect or retry a mutation.
        const verified = await this.send('api/status');
        if (!verified.ok) {
            throw await this.responseError(verified, 'password-login-verification');
        }
        await verified.body?.cancel();
    }
    url(route) {
        const url = new URL(route, this.base);
        if (url.origin !== this.base.origin ||
            !url.pathname.startsWith(this.base.pathname) ||
            url.username ||
            url.password ||
            url.hash) {
            throw new Error('Jupyter request escaped the configured server');
        }
        return url;
    }
    /** Host API only. Mutations are never automatically retried or redirected. */
    async response(route, method = 'GET', body) {
        await this.authenticate();
        return this.send(route, body, true, method);
    }
    /** Headers stay inside the Node host, including for authenticated RTC sockets. */
    async socket(route) {
        await this.authenticate();
        const url = this.url(route);
        const cookie = await (await this.cookieJar()).getCookieString(url.href);
        const authorization = this.httpOptions.authorization
            ? await this.secret(this.httpOptions.authorization)
            : undefined;
        const headers = {
            Origin: this.base.origin,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(authorization ? { Authorization: authorization } : {}),
        };
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return { url: url.href, headers };
    }
}
