import { createHash } from 'node:crypto';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('ModelContextDiscovery');
const cache = new Map();
/** Never confuse output max_tokens with an input/context limit. */
export function readContextLimit(model) {
    for (const field of ['max_input_tokens', 'context_length', 'context_window']) {
        const value = model[field];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 1) {
            return value;
        }
    }
    return undefined;
}
/** Query only the configured provider; never send its key to a third-party catalog. */
export async function discoverCompactionWindow(options, signal) {
    const { model } = options;
    if (!model) {
        return undefined;
    }
    // Native Claude IDs already have SDK-owned context/compaction policy.
    // An explicit numeric override bypasses discovery in the provider.
    if (/^claude-/i.test(model)) {
        return undefined;
    }
    let base;
    try {
        base = new URL(options.env?.ANTHROPIC_BASE_URL ??
            process.env.ANTHROPIC_BASE_URL ??
            'https://api.anthropic.com');
        if (!['https:', 'http:'].includes(base.protocol)) {
            throw new Error('Unsupported protocol');
        }
    }
    catch {
        logger.warn({ model }, 'Invalid model API URL; set agent.autoCompactWindow explicitly. No threshold was inferred.');
        return undefined;
    }
    const key = options.env?.ANTHROPIC_API_KEY ||
        options.env?.ANTHROPIC_AUTH_TOKEN ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        '';
    const cacheKey = createHash('sha256')
        .update(JSON.stringify([base.href, model, key]))
        .digest('hex');
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        return cached.window;
    }
    let window;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
        abort.abort();
    }
    const timeout = setTimeout(cancel, 5000);
    try {
        const prefix = base.pathname.replace(/\/$/, '');
        const modelsPath = prefix.endsWith('/anthropic')
            ? `${prefix.slice(0, -'/anthropic'.length)}/models`
            : `${prefix || '/v1'}/models`;
        for (const path of [`${modelsPath}/${encodeURIComponent(model)}`, modelsPath]) {
            const url = new URL(base.href);
            url.pathname = path;
            url.search = '';
            url.hash = '';
            const response = await fetch(url, {
                headers: {
                    authorization: `Bearer ${key}`,
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                signal: abort.signal,
                redirect: 'error',
            });
            if (response.status === 401 || response.status === 403) {
                break;
            }
            if (!response.ok) {
                continue;
            }
            const body = (await response.json());
            const entry = body.id === model
                ? body
                : Array.isArray(body.data)
                    ? body.data.find((row) => row.id === model)
                    : undefined;
            const limit = entry && readContextLimit(entry);
            if (limit) {
                // Leave 20% for output and growth between compaction checks.
                window = Math.floor(limit * 0.8);
                logger.info({ model, contextLimit: limit, autoCompactWindow: window }, 'Resolved model context from provider API');
                break;
            }
        }
    }
    catch {
        // Avoid logging request objects, URLs or errors that could contain keys.
    }
    finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
    }
    if (signal.aborted) {
        return undefined;
    }
    if (cache.size >= 256) {
        cache.delete(cache.keys().next().value);
    }
    cache.set(cacheKey, { window, expires: Date.now() + (window ? 300_000 : 30_000) });
    if (window === undefined) {
        logger.warn({ model }, 'Model API did not provide a context limit; set agent.autoCompactWindow explicitly. No guessed compaction threshold will be injected; SDK behavior is unchanged.');
    }
    return window;
}
/** Delay SDK creation until metadata resolves, retaining cancellation semantics. */
export function withDiscoveredCompaction(input, options, start) {
    const abort = new AbortController();
    let active;
    return {
        handle: {
            close() {
                abort.abort();
                active?.handle.close();
            },
            cancel() {
                abort.abort();
                active?.handle.cancel();
            },
            get sessionId() {
                return active?.handle.sessionId;
            },
        },
        iterator: (async function* () {
            try {
                const window = await discoverCompactionWindow(options, abort.signal);
                if (abort.signal.aborted) {
                    return;
                }
                active = start(input, { ...options, autoCompactWindow: window });
                yield* active.iterator;
            }
            finally {
                abort.abort();
                active?.handle.close();
            }
        })(),
    };
}
