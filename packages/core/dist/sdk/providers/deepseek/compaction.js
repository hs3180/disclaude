import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('DshCompaction');
/** Conservative capacity when the selected endpoint publishes no model metadata. */
export const DEFAULT_DSH_CONTEXT_WINDOW = 65_536;
const RATIO = 0.8;
/** Resolve only the bound API's capacity; credentials never visit another origin. */
export async function resolveDshCompaction(api, apiKey, window, signal) {
    signal.throwIfAborted();
    if (typeof window === 'number') {
        if (!Number.isSafeInteger(window) || window < 0) {
            throw new TypeError('DSH autoCompactWindow must be a non-negative safe integer');
        }
        if (window === 0) {
            return { auto: false, thresholdRatio: RATIO, source: 'disabled' };
        }
        if (!api) {
            throw new Error('DSH autoCompactWindow requires a bound llms.api connection; native profiles own their compaction policy');
        }
        // DSH's public policy accepts a capacity and ratio, rather than an
        // absolute trigger. Preserve the configured trigger and output headroom.
        const contextWindow = Math.max(DEFAULT_DSH_CONTEXT_WINDOW, Math.ceil(window / RATIO));
        return { auto: true, thresholdRatio: window / contextWindow, contextWindow, source: 'configured' };
    }
    if (!api) {
        return { auto: true, thresholdRatio: RATIO, source: 'native-profile' };
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
        abort.abort();
    }
    const timer = setTimeout(cancel, 3000);
    let contextWindow;
    try {
        const base = new URL(api.baseUrl);
        const prefix = base.pathname.replace(/\/$/, '').replace(/\/anthropic$/, '');
        const modelsPath = `${prefix || '/v1'}/models`;
        for (const path of [`${modelsPath}/${encodeURIComponent(api.model)}`, modelsPath]) {
            const url = new URL(base.href);
            url.pathname = path;
            url.search = '';
            url.hash = '';
            const response = await fetch(url, { signal: abort.signal, redirect: 'error', headers: {
                    authorization: `Bearer ${apiKey ?? ''}`,
                    ...(api.protocol === 'anthropic' ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' } : {}),
                } });
            if (response.status === 401 || response.status === 403) {
                break;
            }
            if (!response.ok) {
                continue;
            }
            const body = await response.json();
            const entry = body.id === api.model ? body
                : Array.isArray(body.data) ? body.data.find(row => row.id === api.model) : undefined;
            for (const key of ['max_input_tokens', 'context_length', 'context_window']) {
                const value = entry?.[key];
                if (typeof value === 'number' && Number.isSafeInteger(value) && value > 1) {
                    contextWindow = value;
                    break;
                }
            }
            if (contextWindow) {
                break;
            }
        }
    }
    catch {
        // Fetch errors may include private endpoints and credentials. Log only
        // the policy decision below, never request/error objects.
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
    }
    signal.throwIfAborted();
    if (!contextWindow) {
        logger.warn({ model: api.model, contextWindow: DEFAULT_DSH_CONTEXT_WINDOW }, 'DSH model context capacity unavailable; using conservative fallback. Set agent.autoCompactWindow for this model.');
    }
    return { auto: true, thresholdRatio: RATIO, contextWindow: contextWindow ?? DEFAULT_DSH_CONTEXT_WINDOW,
        source: contextWindow ? 'model-api' : 'fallback' };
}
