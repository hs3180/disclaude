import { randomUUID } from 'node:crypto';
import { sanitizeDiagnosticText } from "../../core/dist/index.js";
const object = (value) => value && typeof value === 'object' ? value : {};
/** Defense-in-depth at the REST boundary: drop anything that could carry a credential or URL. */
function safeErrmsgText(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.trim().slice(0, 120);
    return text && !/token|secret|signature|credential|password|authorization|https?:|\/\//i.test(text)
        && /^[\p{L}\p{N}\p{P}\p{Zs}]{1,120}$/u.test(text) ? text : undefined;
}
const AUTH_EXPIRED_CODES = new Set([-14, 401]);
/**
 * Extract #5616 structured diagnostics from a channel failure's cause chain.
 * Detects the WeChat API error structurally (name + allowlisted detail) and
 * classifies only what the failure itself proves; returns undefined for
 * non-WeChat errors so the body stays as before.
 */
function wechatDeliveryDiagnostics(error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('WeChat')) {
        return undefined;
    }
    let source = error;
    for (let depth = 0; depth < 4 && source instanceof Error; depth++) {
        const api = source;
        const detail = object(api.detail);
        if (api.name === 'WeChatApiError' && typeof api.code === 'number' && Object.keys(detail).length > 0) {
            const loginExpired = api.authExpired === true || AUTH_EXPIRED_CODES.has(api.code);
            const errmsg = safeErrmsgText(detail.errmsg);
            return {
                channel: 'wechat',
                errorKind: loginExpired ? 'login-expired' : 'delivery-rejected',
                sessionState: loginExpired ? 'login-expired' : 'unverified',
                ...(typeof detail.endpoint === 'string' ? { endpoint: detail.endpoint } : {}),
                ...(typeof detail.httpStatus === 'number' ? { httpStatus: detail.httpStatus } : {}),
                ...(typeof detail.ret === 'number' ? { ret: detail.ret } : {}),
                ...(typeof detail.errcode === 'number' ? { errcode: detail.errcode } : {}),
                ...(errmsg ? { errmsg } : {}),
                ...(typeof detail.diagnosticId === 'string' ? { channelDiagnosticId: detail.diagnosticId } : {}),
            };
        }
        source = source.cause;
    }
    // postMessage's fixed literal for timeout/network/refused responses: the
    // delivery outcome is unknown, not rejected — the only honest classification.
    return message.includes('delivery outcome unknown')
        ? { channel: 'wechat', errorKind: 'delivery-outcome-unknown', sessionState: 'unverified' }
        : undefined;
}
/** Allowlist provider rejection details. Axios request/config/headers never leave this boundary. */
export function channelError(error, secrets = []) {
    const response = object(object(error).response);
    const upstreamStatus = typeof response.status === 'number' && response.status >= 400 && response.status <= 599
        ? response.status : undefined;
    const data = object(response.data);
    const upstreamCode = typeof data.code === 'number' ? data.code : undefined;
    const detail = typeof data.msg === 'string' ? data.msg : typeof data.message === 'string' ? data.message
        : typeof object(data.error).message === 'string' ? object(data.error).message
            : error instanceof Error ? error.message : 'Channel request failed';
    const diagnosticId = randomUUID();
    const diagnostics = wechatDeliveryDiagnostics(error);
    return { status: upstreamStatus ? upstreamStatus < 500 ? upstreamStatus : 502 : 500,
        body: { ok: false, diagnosticId, ...(upstreamStatus ? { upstreamStatus } : {}),
            ...(upstreamCode !== undefined ? { upstreamCode } : {}),
            ...(diagnostics ? { diagnostics } : {}),
            message: `${upstreamStatus ? `Channel upstream HTTP ${upstreamStatus}` : 'Channel request failed'}${upstreamCode !== undefined ? ` / code ${upstreamCode}` : ''}: ${sanitizeDiagnosticText(detail, secrets)} (diagnostic ID ${diagnosticId})` } };
}
