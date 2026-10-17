import { setTimeout as delay } from 'node:timers/promises';
import { computeBackoffDelay } from '../../../utils/retry.js';
export const CODEX_OVERLOAD_MAX_RETRIES = 2;
const MAX_TOTAL_WAIT_MS = 30_000;
const TIMING = { initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000, jitter: true };
const OVERLOAD_CODE = /^(?:serverOverloaded|server_overloaded|server_is_overloaded|overloaded_error)$/i;
/** Transient failure wording eligible for the bounded retry: 503/429 statuses (#5269, #5408) plus quota-free throttle phrasing. */
const OVERLOAD_TEXT = /server[_ ](?:is[_ ])?overload(?:ed)?|overloaded_error|(?:selected )?model is at capacity|(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:503|429)\b|too many requests|rate.?limit reached/i;
/** Terminal surfaces never retried. `rate_limit_exceeded` is the ChatGPT-backend quota signature, not a seconds-scale throttle (#5408). */
const NON_TRANSIENT = /\b(?:401|403)\b|unauthori[sz]ed|permission denied|invalid (?:configuration|request)|validation (?:error|failed)|usage limit|quota (?:exceeded|exhausted)|rate_limit_exceeded/i;
export function readCodexOverloadFailure(value, now = Date.now()) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const error = value;
    const message = typeof error.message === 'string' ? error.message : '';
    const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : '';
    const info = error.codexErrorInfo ?? error.code;
    let overloaded = false;
    if (typeof info === 'string' && info !== 'other') {
        // A native non-transient code takes precedence over incidental wording.
        overloaded = OVERLOAD_CODE.test(info);
    }
    else if (info && typeof info === 'object') {
        overloaded = Object.entries(info).some(([kind, detail]) => ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind)
            && !!detail && typeof detail === 'object'
            && detail.httpStatusCode !== undefined
            && [503, 429].includes(detail.httpStatusCode));
    }
    else {
        overloaded = !NON_TRANSIENT.test(message) && OVERLOAD_TEXT.test(message);
    }
    if (!overloaded) {
        return undefined;
    }
    const hint = /\bretry-after\s*:\s*([^\r\n]+)/i.exec(`${message}\n${details}`)?.[1]?.trim();
    let retryAfterMs;
    if (hint) {
        if (/^\d+$/.test(hint)) {
            retryAfterMs = Number(hint) * 1000;
        }
        else {
            const date = Date.parse(hint);
            if (Number.isFinite(date)) {
                retryAfterMs = Math.max(0, date - now);
            }
        }
    }
    return { message: `${typeof info === 'string' ? `${info}: ` : ''}${message}${details ? `\n${details}` : ''}`,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}
export function codexOverloadRetryDelay(failure, attempt, waitedMs) {
    if (attempt >= CODEX_OVERLOAD_MAX_RETRIES) {
        return undefined;
    }
    const delayMs = Math.max(failure.retryAfterMs ?? 0, computeBackoffDelay(attempt, TIMING));
    // Never shorten a valid server hint to fit the budget: defer instead.
    return Number.isFinite(delayMs) && waitedMs + delayMs <= MAX_TOTAL_WAIT_MS ? delayMs : undefined;
}
export async function waitForCodexOverloadRetry(delayMs, signal) {
    try {
        await delay(delayMs, undefined, { signal });
        return true;
    }
    catch (error) {
        if (signal.aborted) {
            return false;
        }
        throw error;
    }
}
