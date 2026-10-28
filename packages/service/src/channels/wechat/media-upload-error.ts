import { randomUUID } from 'node:crypto';
import { safeMediaCause } from './media-error.js';

type Stage = 'validate' | 'encrypt' | 'negotiate' | 'reference' | 'upload' | 'receipt';
type Reason = 'size' | 'local' | 'negotiate' | 'reference' | 'network' | 'timeout' | 'cancelled' | 'http' | 'receipt';

/** Only bounded allowlisted diagnostics survive into logs and the CLI error. */
export class WeChatMediaUploadError extends Error {
  readonly detail;
  readonly authExpired: boolean;
  constructor(detail: { stage: Stage; reason: Reason; elapsedMs: number; bytes: number; encryptedBytes: number; httpStatus?: number }, error?: unknown) {
    const cause = safeMediaCause(error);
    const diagnosticId = randomUUID();
    const upstream = error && typeof error === 'object' ? error as { code?: unknown; detail?: { httpStatus?: unknown } } : undefined;
    const status = detail.httpStatus ?? upstream?.detail?.httpStatus;
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const apiCode = typeof upstream?.code === 'number' && Number.isSafeInteger(upstream.code) && Math.abs(upstream.code) <= 1_000_000_000 ? upstream.code : undefined;
    const elapsedMs = Math.max(0, Math.round(detail.elapsedMs));
    const message = detail.reason === 'size' ? 'File too large: WeChat adapter limit is 20 MiB'
      : detail.reason === 'reference' ? 'WeChat upload response missing or unsupported upload URL'
      : detail.reason === 'receipt' ? 'WeChat CDN upload missing download reference'
      : 'WeChat media upload failed';
    super(`${message}; message was not sent; stage=${detail.stage}, reason=${detail.reason}${httpStatus ? `, HTTP ${httpStatus}` : ''}` +
      `${apiCode !== undefined ? `, API ${apiCode}` : ''}${cause ? `, ${cause.name}${cause.code ? `/${cause.code}` : ''}` : ''}; elapsedMs=${elapsedMs}, bytes=${detail.bytes}, encryptedBytes=${detail.encryptedBytes}, attempt=1; diagnostic ID ${diagnosticId}`, { cause });
    this.name = 'WeChatMediaUploadError';
    this.authExpired = apiCode === -14 || httpStatus === 401;
    this.detail = Object.freeze({ ...detail, httpStatus, apiCode, elapsedMs, attempt: 1, diagnosticId, messageSent: false, ...(cause ? { cause } : {}) });
  }
}
