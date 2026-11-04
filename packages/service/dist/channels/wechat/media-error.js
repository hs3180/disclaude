import { randomUUID } from 'node:crypto';
const messages = {
    reference: 'WeChat attachment has no download reference', host: 'Unsupported WeChat media URL',
    network: 'WeChat media download failed or timed out', http: 'WeChat media download failed',
    empty: 'WeChat media response has no body', size: 'WeChat attachment exceeds the 20 MiB adapter limit',
    key: 'Invalid WeChat media encryption key', decrypt: 'Cannot decrypt WeChat attachment',
    write: 'Cannot save WeChat attachment', cancelled: 'WeChat media download cancelled',
};
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'UND_ERR_REQ_RETRY', 'UND_ERR_ABORTED',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ABORT_ERR', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EIO']);
const names = ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AggregateError'];
/** First allowlisted `code` inside an AggregateError's per-address errors, if any. */
function aggregateCode(errors) {
    if (!Array.isArray(errors)) {
        return undefined;
    }
    for (const entry of errors) {
        if (entry && typeof entry === 'object') {
            const { code } = entry;
            if (typeof code === 'string' && codes.has(code)) {
                return code;
            }
        }
    }
    return undefined;
}
/** Shared upload/download diagnostic boundary; no raw error or message retained. */
export function safeMediaCause(error) {
    let source = error;
    let name = 'Error', code;
    for (let depth = 0; depth < 3 && source && typeof source === 'object'; depth++) {
        const current = source;
        const { name: causeName, code: causeCode, cause: next, errors } = current;
        if (depth === 0 && typeof causeName === 'string' && names.includes(causeName)) {
            name = causeName;
        }
        if (typeof causeCode === 'string' && codes.has(causeCode)) {
            code = causeCode;
        }
        // Undici races multiple addresses (happy-eyeballs) and reports per-address
        // connect failures as an AggregateError under `TypeError: fetch failed`
        // (#5516): without walking `errors`, an intermittent connect failure is
        // reduced to a code-less generic error.
        code ??= aggregateCode(errors);
        source = next;
    }
    return error === undefined ? undefined : Object.freeze({ name, ...(code ? { code } : {}) });
}
/** Never retain raw errors: they can contain signed URLs, decryption keys or local paths. */
export class WeChatMediaError extends Error {
    detail;
    retryable;
    constructor(detail, error) {
        const cause = safeMediaCause(error);
        const httpStatus = typeof detail.httpStatus === 'number' && Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599 ? detail.httpStatus : undefined;
        super(messages[detail.reason] + (httpStatus ? ` [${httpStatus}]` : ''), { cause });
        this.name = 'WeChatMediaError';
        this.retryable = ['network', 'empty', 'write'].includes(detail.reason)
            || (detail.reason === 'http' && httpStatus !== undefined && (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500));
        this.detail = Object.freeze({ diagnosticId: randomUUID(), stage: detail.stage, reason: detail.reason, retryable: this.retryable,
            elapsedMs: Math.max(0, Math.round(detail.elapsedMs)), bytes: detail.bytes, httpStatus, ...(cause ? { cause } : {}) });
    }
}
