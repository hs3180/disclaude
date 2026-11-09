import { randomUUID } from 'node:crypto';
import { safeMediaCause } from './media-error.js';

type Stage = 'validate' | 'encrypt' | 'negotiate' | 'reference' | 'upload' | 'receipt';
type Reason = 'size' | 'local' | 'negotiate' | 'reference' | 'network' | 'timeout' | 'cancelled' | 'http' | 'receipt';
/**
 * #5720 (T-101): which transport phase of the CDN POST the failure belongs to —
 * `connect` = DNS/TCP/TLS establishment, `write` = request body transfer,
 * `response` = awaiting/reading the receipt. Fixed enum + millisecond
 * durations only; never URL, credential or payload data.
 */
export type WeChatUploadPhase = 'connect' | 'write' | 'response';

export interface WeChatUploadPhaseDetail {
  phase: WeChatUploadPhase;
  /** DNS+TCP+TLS establishment duration (undefined if never established). */
  connectMs?: number;
  /** Connected → request body fully written (undefined if never finished). */
  writeMs?: number;
  /** Body written → receipt complete (undefined if it never got that far). */
  responseMs?: number;
  /** Bytes confirmed handed to the transport: 0 until `finish`, then the ciphertext size. */
  writtenBytes: number;
}

/** Only bounded allowlisted diagnostics survive into logs and the CLI error. */
export class WeChatMediaUploadError extends Error {
  readonly detail;
  readonly authExpired: boolean;
  constructor(detail: {
    stage: Stage; reason: Reason; elapsedMs: number; bytes: number; encryptedBytes: number; httpStatus?: number;
    attempt?: number; phases?: WeChatUploadPhaseDetail;
  }, error?: unknown) {
    const cause = safeMediaCause(error);
    const diagnosticId = randomUUID();
    const upstream = error && typeof error === 'object' ? error as { code?: unknown; detail?: { httpStatus?: unknown } } : undefined;
    const status = detail.httpStatus ?? upstream?.detail?.httpStatus;
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const apiCode = typeof upstream?.code === 'number' && Number.isSafeInteger(upstream.code) && Math.abs(upstream.code) <= 1_000_000_000 ? upstream.code : undefined;
    const elapsedMs = Math.max(0, Math.round(detail.elapsedMs));
    const attempt = detail.attempt !== undefined && detail.attempt > 0 ? detail.attempt : 1;
    const { phases } = detail;
    const round = (value: number | undefined) => value === undefined ? undefined : Math.max(0, Math.round(value));
    const message = detail.reason === 'size' ? 'File too large: WeChat adapter limit is 20 MiB'
      : detail.reason === 'reference' ? 'WeChat upload response missing or unsupported upload URL'
      : detail.reason === 'receipt' ? 'WeChat CDN upload missing download reference'
      : 'WeChat media upload failed';
    super(`${message}; message was not sent; stage=${detail.stage}, reason=${detail.reason}` +
      `${phases ? `, phase=${phases.phase}` : ''}${httpStatus ? `, HTTP ${httpStatus}` : ''}` +
      `${apiCode !== undefined ? `, API ${apiCode}` : ''}${cause ? `, ${cause.name}${cause.code ? `/${cause.code}` : ''}` : ''}` +
      `; elapsedMs=${elapsedMs}, bytes=${detail.bytes}, encryptedBytes=${detail.encryptedBytes}` +
      `${phases ? `, writtenBytes=${phases.writtenBytes}` : ''}, attempt=${attempt}; diagnostic ID ${diagnosticId}`, { cause });
    this.name = 'WeChatMediaUploadError';
    this.authExpired = apiCode === -14 || httpStatus === 401;
    this.detail = Object.freeze({
      ...detail, httpStatus, apiCode, elapsedMs, attempt,
      ...(phases ? {
        phase: phases.phase, writtenBytes: phases.writtenBytes,
        ...(phases.connectMs !== undefined ? { connectMs: round(phases.connectMs) } : {}),
        ...(phases.writeMs !== undefined ? { writeMs: round(phases.writeMs) } : {}),
        ...(phases.responseMs !== undefined ? { responseMs: round(phases.responseMs) } : {}),
      } : {}),
      diagnosticId, messageSent: false, ...(cause ? { cause } : {}),
    });
  }
}
