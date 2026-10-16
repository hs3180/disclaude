import { randomUUID } from 'node:crypto';
import { sanitizeDiagnosticText } from "../../core/dist/index.js";
const object = (value) => value && typeof value === 'object' ? value : {};
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
    return { status: upstreamStatus ? upstreamStatus < 500 ? upstreamStatus : 502 : 500,
        body: { ok: false, diagnosticId, ...(upstreamStatus ? { upstreamStatus } : {}),
            ...(upstreamCode !== undefined ? { upstreamCode } : {}),
            message: `${upstreamStatus ? `Channel upstream HTTP ${upstreamStatus}` : 'Channel request failed'}${upstreamCode !== undefined ? ` / code ${upstreamCode}` : ''}: ${sanitizeDiagnosticText(detail, secrets)} (diagnostic ID ${diagnosticId})` } };
}
