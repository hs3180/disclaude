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
            return value;
        }
        catch {
            throw new Error('Jupyter connection authentication is unavailable');
        }
    }
    async send(route, body, loginRedirect = false, method = body ? 'POST' : 'GET') {
        const url = this.url(route);
        const authorization = this.httpOptions.authorization
            ? await this.secret(this.httpOptions.authorization)
            : undefined;
        const cookies = await this.cookieJar();
        const cookie = await cookies.getCookieString(url.href);
        if (Buffer.byteLength(cookie) > 16_384) {
            throw new Error('Jupyter session cookie limit exceeded');
        }
        let response;
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
        catch {
            // Fetch errors may quote a rejected Authorization value. Keep them host-private.
            throw new Error('Jupyter request outcome could not be verified');
        }
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
            throw new Error('Jupyter redirect was refused');
        }
        return response;
    }
    async responseText(response) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Jupyter coordinator response body is missing');
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
                    throw new Error('Jupyter coordinator response limit exceeded');
                }
                chunks.push(value);
            }
        }
        finally {
            await reader.cancel();
        }
        return Buffer.concat(chunks).toString('utf8');
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
        await existing.body?.cancel();
        if (existing.ok) {
            return;
        }
        if (![401, 403].includes(existing.status)) {
            throw new Error(`Jupyter authentication check returned HTTP ${existing.status}`);
        }
        const page = await this.send('login');
        await page.body?.cancel();
        if (!page.ok) {
            throw new Error('Jupyter password login is unavailable');
        }
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
            throw new Error('Jupyter password login failed');
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
        await verified.body?.cancel();
        if (!verified.ok) {
            throw new Error('Jupyter password login could not be verified');
        }
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
