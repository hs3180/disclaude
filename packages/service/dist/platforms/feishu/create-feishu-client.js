/**
 * Factory function to create Lark Client with timeout and retry configuration.
 *
 * The @larksuiteoapi/node-sdk doesn't support requestTimeout directly,
 * so we create a custom axios instance with timeout and wrap it as HttpInstance.
 *
 * Retry mechanism (Issue #507):
 * - Automatically retries on transient network errors (ETIMEDOUT, ECONNRESET, etc.)
 * - Uses exponential backoff with jitter to avoid thundering herd
 * - Logs retry attempts for debugging
 *
 * Migrated to @disclaude/service (Issue #1040)
 */
import * as lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { FEISHU_API, RETRYABLE_ERROR_CODES, createLogger, sanitizeDiagnosticText } from "../../../../core/dist/index.js";
const logger = createLogger('FeishuClient');
/**
 * Structured forensics for failed channel HTTP calls (#5655).
 *
 * Message-type POSTs are never retried on 5xx (#507 ambiguous-delivery rule),
 * so the failure branch of requestWithRetry is the only place a transient Feishu
 * error body (code/msg — the sole evidence for classifying the failure) can be
 * preserved. Everything below is allowlisted and truncated before it reaches logs.
 */
/** Response headers worth keeping for Feishu support escalations (allowlist). */
const DIAGNOSTIC_HEADER_ALLOWLIST = new Set([
    'x-request-id', // Feishu support asks for this first
    'x-ogw-lbnet', 'x-ogw-traceid', // gateway routing/trace
    'retry-after', // rate-limit context
]);
/** Error bodies are provider diagnostics, not user content: ~2KB is far beyond
 * any observed Feishu code/msg payload while staying a single log line. */
const RESPONSE_BODY_LOG_LIMIT = 2048;
/** Request bodies carry chat content: keep only the envelope shape (receive_id
 * type, msg_type, truncated content prefix), never the full text. 512 chars is
 * enough to identify the payload shape without persisting whole conversations. */
const REQUEST_BODY_LOG_LIMIT = 512;
function truncateForLog(value, limit) {
    if (value === undefined || value === null) {
        return undefined;
    }
    let raw;
    if (typeof value === 'string') {
        raw = value;
    }
    else {
        try {
            raw = JSON.stringify(value);
        }
        catch {
            return undefined;
        }
    }
    return raw.length > limit ? `${raw.slice(0, limit)}…[truncated ${raw.length - limit} chars]` : raw;
}
function diagnosticHeaderSubset(headers) {
    if (!headers || typeof headers !== 'object') {
        return undefined;
    }
    const subset = {};
    for (const [name, value] of Object.entries(headers)) {
        if (DIAGNOSTIC_HEADER_ALLOWLIST.has(name.toLowerCase()) &&
            (typeof value === 'string' || typeof value === 'number')) {
            subset[name] = String(value).slice(0, 128);
        }
    }
    return Object.keys(subset).length > 0 ? subset : undefined;
}
/**
 * Method/URL/status + allowlisted response headers + truncated-and-sanitized
 * request/response bodies, ready to spread into a pino log field.
 */
function feishuHttpFailureDetail(error) {
    if (!axios.isAxiosError(error)) {
        return {};
    }
    const axiosError = error;
    const config = axiosError.config;
    const { response } = axiosError;
    const detail = {
        method: typeof config?.method === 'string' ? config.method.toUpperCase() : undefined,
        url: typeof config?.url === 'string' ? config.url : undefined,
        status: response?.status,
    };
    const headers = diagnosticHeaderSubset(response?.headers);
    if (headers) {
        detail.responseHeaders = headers;
    }
    const responseBody = truncateForLog(response?.data, RESPONSE_BODY_LOG_LIMIT);
    if (responseBody !== undefined) {
        detail.responseBody = sanitizeDiagnosticText(responseBody);
    }
    const requestBody = truncateForLog(config?.data, REQUEST_BODY_LOG_LIMIT);
    if (requestBody !== undefined) {
        detail.requestBody = sanitizeDiagnosticText(requestBody);
    }
    return detail;
}
/**
 * Append the Feishu business error (response body code/msg) to the axios
 * message so downstream consumers that only see `error.message` — ❌ user
 * notifications and the scheduler pass-through path — carry the Feishu
 * internal error code instead of a bare "Request failed with status code 500".
 */
function annotateFeishuBusinessError(error) {
    if (!axios.isAxiosError(error)) {
        return;
    }
    const data = error.response?.data;
    if (!data || (data.code === undefined && data.msg === undefined)) {
        return;
    }
    if (error.message.includes('feishu code ')) {
        return;
    }
    const codePart = data.code !== undefined ? String(data.code) : '?';
    const msgPart = typeof data.msg === 'string' && data.msg.trim()
        ? `: ${sanitizeDiagnosticText(data.msg).slice(0, 200)}` : '';
    error.message = `${error.message} (feishu code ${codePart}${msgPart})`;
}
/**
 * Check if an error is retryable (transient network error).
 */
function isRetryableError(error) {
    if (!axios.isAxiosError(error)) {
        return false;
    }
    const axiosError = error;
    // Network errors (no response received)
    if (!axiosError.response && axiosError.code) {
        return RETRYABLE_ERROR_CODES.includes(axiosError.code);
    }
    // Server errors (5xx) are potentially retryable
    if (axiosError.response?.status) {
        const { status } = axiosError.response;
        // 429 Too Many Requests, 500+ server errors
        return status === 429 || (status >= 500 && status < 600);
    }
    return false;
}
/**
 * Calculate delay with exponential backoff and jitter.
 * This helps avoid thundering herd problem when multiple clients retry simultaneously.
 */
function calculateRetryDelay(attempt) {
    const { INITIAL_DELAY_MS, MAX_DELAY_MS, BACKOFF_MULTIPLIER } = FEISHU_API.RETRY;
    const exponentialDelay = INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
    const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);
    // Add jitter (random 0-20% of delay) to spread out retries
    const jitter = cappedDelay * Math.random() * 0.2;
    return Math.floor(cappedDelay + jitter);
}
/**
 * Sleep for specified milliseconds.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Wrap axios request with retry logic.
 */
async function requestWithRetry(requestFn, context, retryAmbiguousFailure = true) {
    const { MAX_RETRIES } = FEISHU_API.RETRY;
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await requestFn();
        }
        catch (error) {
            lastError = error;
            // Check if we should retry
            if (!isRetryableError(error) ||
                (!retryAmbiguousFailure && error.response?.status !== 429)) {
                annotateFeishuBusinessError(error);
                // #5655: message POSTs get no retry (and no retry warn) on 5xx, so this
                // branch is their only forensic trace — keep method/URL/status/headers
                // subset/bodies in one structured record instead of a bare axios line.
                const status = error.response?.status;
                const failure = { context, ...feishuHttpFailureDetail(error) };
                if (status === undefined || status >= 500) {
                    logger.error(failure, 'Feishu channel HTTP request failed (no retry)');
                }
                else {
                    logger.warn(failure, 'Feishu channel HTTP request failed (no retry)');
                }
                throw error;
            }
            // Don't sleep after the last attempt
            if (attempt < MAX_RETRIES) {
                const delay = calculateRetryDelay(attempt);
                const axiosError = error;
                logger.warn({
                    context,
                    attempt: attempt + 1,
                    maxRetries: MAX_RETRIES,
                    delayMs: delay,
                    errorCode: axiosError.code,
                    errorMessage: axiosError.message,
                    status: axiosError.response?.status,
                }, 'Request failed, retrying...');
                await sleep(delay);
            }
        }
    }
    // All retries exhausted
    const axiosError = lastError;
    annotateFeishuBusinessError(lastError);
    logger.error({
        context,
        maxRetries: MAX_RETRIES,
        errorCode: axiosError?.code,
        errorMessage: axiosError?.message,
        ...feishuHttpFailureDetail(lastError),
    }, 'All retry attempts exhausted');
    throw lastError;
}
/** Message creation/replies have no known receipt after a lost response. */
function retryAmbiguousRequest(method, url) {
    if (method?.toLowerCase() !== 'post') {
        return true;
    }
    if (!url) {
        return false;
    }
    const { pathname } = new URL(url, 'https://open.feishu.cn');
    return !/\/im\/v1\/messages(?:\/[^/]+\/reply)?\/?$/.test(pathname);
}
/**
 * Wrap an axios instance to match lark SDK's HttpInstance interface.
 * Includes retry logic for transient errors.
 */
/**
 * Process axios response, handling $return_headers option used by lark SDK.
 *
 * The lark SDK's default HTTP instance checks `resp.config['$return_headers']`
 * via a response interceptor to return `{ data, headers }` instead of just `data`.
 * Our custom wrapper needs to replicate this behavior, particularly for
 * `im.messageResource.get()` which downloads files via streams.
 */
function processResponse(res, opts) {
    if (opts.$return_headers) {
        return { data: res.data, headers: res.headers };
    }
    return res.data;
}
function wrapAxiosAsHttpInstance(axiosInstance) {
    return {
        request: async (opts) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawOpts = opts;
            return await requestWithRetry(() => axiosInstance.request({
                url: opts.url,
                method: opts.method,
                headers: opts.headers,
                params: opts.params,
                data: opts.data,
                responseType: opts.responseType,
                timeout: opts.timeout,
            }).then(res => processResponse(res, rawOpts)), `request ${opts.method} ${opts.url}`, retryAmbiguousRequest(opts.method, opts.url));
        },
        get: async (url, opts) => {
            return await requestWithRetry(() => axiosInstance.get(url, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `get ${url}`);
        },
        delete: async (url, opts) => {
            return await requestWithRetry(() => axiosInstance.delete(url, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `delete ${url}`);
        },
        head: async (url, opts) => {
            return await requestWithRetry(() => axiosInstance.head(url, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `head ${url}`);
        },
        options: async (url, opts) => {
            return await requestWithRetry(() => axiosInstance.options(url, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `options ${url}`);
        },
        post: async (url, data, opts) => {
            return await requestWithRetry(() => axiosInstance.post(url, data, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `post ${url}`, retryAmbiguousRequest('post', url));
        },
        put: async (url, data, opts) => {
            return await requestWithRetry(() => axiosInstance.put(url, data, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `put ${url}`);
        },
        patch: async (url, data, opts) => {
            return await requestWithRetry(() => axiosInstance.patch(url, data, {
                params: opts?.params,
                headers: opts?.headers,
                timeout: opts?.timeout,
                responseType: opts?.responseType,
            }).then(res => res.data), `patch ${url}`);
        },
    };
}
/**
 * Create a Lark Client with configured request timeout and retry.
 *
 * @param appId - Feishu App ID
 * @param appSecret - Feishu App Secret
 * @param options - Optional configuration
 * @returns Configured Lark Client instance
 */
export function createFeishuClient(appId, appSecret, options) {
    // Create axios instance with default timeout
    const axiosInstance = axios.create({
        timeout: FEISHU_API.REQUEST_TIMEOUT_MS,
    });
    // Wrap axios as lark HttpInstance (with retry logic)
    const httpInstance = wrapAxiosAsHttpInstance(axiosInstance);
    // The SDK's console logger can dump Axios config (including auth headers).
    // Keep its summary in the redacted service logger; REST handlers retain safe
    // provider status/code/reason separately.
    const safeArgs = (args) => args.map(value => value instanceof Error
        ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : '[SDK structured detail omitted]').join(' ');
    const sdkLogger = Object.fromEntries(['error', 'warn', 'info', 'debug', 'trace'].map(level => [level,
        (...args) => logger[level](safeArgs(args))]));
    // Create and return lark Client with custom httpInstance
    return new lark.Client({
        appId,
        appSecret,
        domain: options?.domain ?? lark.Domain.Feishu,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: (options?.logger ?? sdkLogger),
        loggerLevel: options?.loggerLevel,
        httpInstance,
    });
}
