import { randomUUID } from 'node:crypto';

type Stage = 'reference' | 'fetch' | 'read' | 'decrypt' | 'write';
type Reason = 'reference' | 'host' | 'network' | 'http' | 'empty' | 'size' | 'key' | 'decrypt' | 'write' | 'cancelled';
const messages: Record<Reason, string> = {
  reference: 'WeChat attachment has no download reference', host: 'Unsupported WeChat media URL',
  network: 'WeChat media download failed or timed out', http: 'WeChat media download failed',
  empty: 'WeChat media response has no body', size: 'WeChat attachment exceeds the 20 MiB adapter limit',
  key: 'Invalid WeChat media encryption key', decrypt: 'Cannot decrypt WeChat attachment',
  write: 'Cannot save WeChat attachment', cancelled: 'WeChat media download cancelled',
};
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ABORT_ERR', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EIO']);

/** Never retain raw errors: they can contain signed URLs, decryption keys or local paths. */
export class WeChatMediaError extends Error {
  readonly detail;
  readonly retryable: boolean;
  constructor(detail: { stage: Stage; reason: Reason; elapsedMs: number; bytes?: number; httpStatus?: number }, error?: unknown) {
    let source = error;
    let name = 'Error', code: string | undefined;
    for (let depth = 0; depth < 3 && source && typeof source === 'object'; depth++) {
      const current = source as { name?: unknown; code?: unknown; cause?: unknown };
      const { name: causeName, code: causeCode, cause: next } = current;
      if (depth === 0 && typeof causeName === 'string' && ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(causeName)) { name = causeName; }
      if (typeof causeCode === 'string' && codes.has(causeCode)) { code = causeCode; }
      source = next;
    }
    const cause = error === undefined ? undefined : Object.freeze({ name, ...(code ? { code } : {}) });
    const httpStatus = typeof detail.httpStatus === 'number' && Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599 ? detail.httpStatus : undefined;
    super(messages[detail.reason] + (httpStatus ? ` [${httpStatus}]` : ''), { cause });
    this.name = 'WeChatMediaError';
    this.retryable = ['network', 'empty', 'write'].includes(detail.reason)
      || (detail.reason === 'http' && httpStatus !== undefined && (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500));
    this.detail = Object.freeze({ diagnosticId: randomUUID(), stage: detail.stage, reason: detail.reason, retryable: this.retryable,
      elapsedMs: Math.max(0, Math.round(detail.elapsedMs)), bytes: detail.bytes, httpStatus, ...(cause ? { cause } : {}) });
  }
}
