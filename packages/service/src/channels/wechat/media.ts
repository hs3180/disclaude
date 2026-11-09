import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { basename, join } from 'node:path';
import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatImageItem, WeChatFileItem, WeChatUploadedMedia } from './types.js';
import { WeChatMediaError, safeMediaCause } from './media-error.js';
import { WeChatMediaUploadError } from './media-upload-error.js';

/** Adapter policy, not a claim about the gateway's maximum. */
export const WECHAT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const logger = createLogger('WeChatMedia');

/**
 * #5516: a failed CDN upload previously reached operator logs only as a
 * flattened message string (via the base channel's catch), so intermittent
 * undici transport failures were indistinguishable. Emit the allowlisted,
 * already-redacted `detail` as searchable pino fields — stage, reason and the
 * underlying cause code (or its equivalent) — before the error propagates.
 */
function logUploadFailure(failure: WeChatMediaUploadError): void {
  logger.warn({ ...failure.detail }, 'WeChat CDN upload failed; message was not sent');
}

function cdnUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid WeChat media URL');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.weixin.qq.com') ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('Unsupported WeChat media host');
  }
  return url.href;
}

function mediaSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * #5516 (T-032): uploads previously used global fetch (undici) under the
 * fixed 15s `mediaSignal` abort deadline, so a ~15 MiB video had to finish
 * DNS + TLS + body + receipt inside 15s regardless of payload size — and
 * undici's happy-eyeballs connect race (see media-error.ts) added
 * intermittent `fetch failed` on top. The 2026-11-02 repro showed
 * https.request delivering the same payload where fetch failed, so the
 * upload channel is now https.request with a size-aware deadline. A
 * 0.004 ms/byte (4 µs/byte) budget is a 250 KiB/s worst-case uplink floor;
 * 15 MiB thus gets 15s + 15,481,296 × 0.004ms ≈ 77s.
 * Downloads keep fetch streaming with the unchanged 15s signal.
 *
 * #5720 (T-101): the whole-budget deadline still expired end-to-end (2.5 MiB
 * at ~25s, 8.34 MiB at ~48s — exactly `uploadDeadlineMs`), but a single timer
 * over connect+write+receipt could not say which phase stalled. The deadline
 * math is kept unchanged (it was correct); it is now split into bounded
 * phase budgets with per-phase timing, so a production timeout names its
 * phase instead of eating the total silently.
 */
export const UPLOAD_DEADLINE_BASE_MS = 15_000;
export const UPLOAD_DEADLINE_MS_PER_BYTE = 0.004;

/** #5720: DNS+TCP+TLS must fit inside this slice of the total budget. */
export const UPLOAD_CONNECT_BUDGET_MS = 10_000;
/**
 * #5720: no-activity watchdog. Any phase that stops making progress (socket
 * drain, body finish, receipt bytes) for this long fails as a timeout even
 * while the total budget still has room — a stalled link is surfaced at
 * ~15s instead of burning a 25–77s size-aware budget on dead air.
 */
export const UPLOAD_STALL_BUDGET_MS = 15_000;
/**
 * #5720: a connect-phase failure is provably safe to retry (no ciphertext
 * byte left the host): fresh negotiation + one more POST. Everything at or
 * past body write is never retried here — the CDN may already hold the body,
 * and the sendmessage step is not reached while the upload fails, so the
 * user-visible message cannot be duplicated by this loop.
 */
export const UPLOAD_MAX_ATTEMPTS = 2;
const RETRYABLE_CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'EHOSTUNREACH',
  'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  // TLS handshake rejected before any body byte was writable.
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

export function uploadDeadlineMs(encryptedBytes: number): number {
  return UPLOAD_DEADLINE_BASE_MS + Math.max(0, encryptedBytes) * UPLOAD_DEADLINE_MS_PER_BYTE;
}

/** Where the transport was when it failed, plus bounded per-phase durations (#5720). */
export interface WeChatUploadProgress {
  phase: 'connect' | 'write' | 'response';
  connectMs?: number;
  writeMs?: number;
  responseMs?: number;
  writtenBytes: number;
}

/** Tag a transport error with its phase snapshot; diagnostics are enums and numbers only. */
function withProgress(error: unknown, progress: WeChatUploadProgress): unknown {
  if (error && typeof error === 'object' && !(error as { uploadProgress?: unknown }).uploadProgress) {
    Object.defineProperty(error, 'uploadProgress', {
      value: Object.freeze({ ...progress }), enumerable: false, configurable: true,
    });
  }
  return error;
}

function readProgress(error: unknown): WeChatUploadProgress | undefined {
  const progress = error && typeof error === 'object' ? (error as { uploadProgress?: unknown }).uploadProgress : undefined;
  return progress && typeof progress === 'object' ? progress as WeChatUploadProgress : undefined;
}

const stallTarget = (phase: WeChatUploadProgress['phase']): string =>
  phase === 'connect' ? 'connection establishment' : phase === 'write' ? 'request body write' : 'receipt response';

const deadlineError = (phase: WeChatUploadProgress['phase']) =>
  Object.assign(new Error(`WeChat CDN upload stalled awaiting ${stallTarget(phase)}`), {
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
  });

/**
 * One POST via https.request; never follows redirects (fetch used redirect: 'error').
 *
 * #5720: instruments the three transport phases — connect/TLS establishment,
 * request-body write, receipt wait — under one total size-aware deadline with
 * per-phase budgets: a bounded connect slice, a no-progress stall watchdog on
 * every phase, and the unchanged total as the hard cap. Honors an optional
 * AbortSignal (destroy → AbortError → reason=cancelled upstream).
 */
function uploadPost(
  url: string,
  body: Buffer,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ status: number; headers: IncomingHttpHeaders; progress: WeChatUploadProgress }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let phase: WeChatUploadProgress['phase'] = 'connect';
    let connectedAt: number | undefined;
    let finishedAt: number | undefined;
    let writtenBytes = 0;
    let lastProgressAt = started;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const snapshot = (): WeChatUploadProgress => ({
      phase,
      writtenBytes,
      ...(connectedAt !== undefined ? { connectMs: connectedAt - started } : {}),
      ...(finishedAt !== undefined && connectedAt !== undefined ? { writeMs: finishedAt - connectedAt } : {}),
      ...(finishedAt !== undefined ? { responseMs: Date.now() - finishedAt } : {}),
    });

    const clearTimers = () => {
      for (const timer of [totalTimer, connectTimer, stallTimer]) { if (timer) { clearTimeout(timer); } }
      totalTimer = connectTimer = stallTimer = undefined;
    };

    const fail = (error: unknown) => {
      clearTimers();
      signal?.removeEventListener('abort', onAbort);
      reject(withProgress(error, snapshot()));
    };

    const markProgress = () => { lastProgressAt = Date.now(); };

    /** A reused keep-alive socket never re-emits secureConnect; first write progress proves the connection. */
    const markConnected = () => {
      if (connectedAt !== undefined) { return; }
      connectedAt = Date.now();
      phase = 'write';
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = undefined; }
      markProgress();
    };

    const armStallWatchdog = () => {
      if (stallTimer) { clearTimeout(stallTimer); }
      const remaining = UPLOAD_STALL_BUDGET_MS - (Date.now() - lastProgressAt);
      if (remaining <= 0) {
        fail(deadlineError(phase));
        return;
      }
      stallTimer = setTimeout(armStallWatchdog, remaining);
    };

    const onAbort = () => {
      req.destroy(new DOMException('WeChat CDN upload cancelled', 'AbortError'));
    };

    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        },
      },
      (res) => {
        markProgress(); // Response headers arrived: the receipt wait is making progress.
        res.on('data', markProgress); // Drain the tiny receipt body; only headers carry state.
        res.on('end', () => {
          clearTimers();
          signal?.removeEventListener('abort', onAbort);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, progress: snapshot() });
        });
        res.on('error', fail);
      }
    );

    totalTimer = setTimeout(() => {
      req.destroy(deadlineError(phase));
    }, timeoutMs);

    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      req.destroy(deadlineError('connect'));
    }, Math.min(UPLOAD_CONNECT_BUDGET_MS, timeoutMs));
    armStallWatchdog();

    if (signal?.aborted) { onAbort(); } else { signal?.addEventListener('abort', onAbort, { once: true }); }

    req.on('socket', (socket) => {
      socket.on('connect', markProgress); // TCP up; TLS handshake still pending.
      socket.on('secureConnect', markConnected);
      socket.on('drain', () => { markConnected(); markProgress(); });
      socket.on('error', () => { /* forwarded by ClientRequest to req 'error' */ });
    });
    req.on('drain', () => { markConnected(); markProgress(); });
    req.on('finish', () => {
      markConnected();
      finishedAt = Date.now();
      writtenBytes = body.length;
      phase = 'response';
      markProgress();
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** Current iLink upload: negotiate -> encrypted CDN POST -> reusable media ref. */
export async function uploadEncryptedMedia(params: {
  fileData: Buffer;
  to: string;
  kind: 'image' | 'file' | 'video';
  /** #5720: cancellation passthrough; abort destroys the POST (reason=cancelled), never retried. */
  signal?: AbortSignal;
  requestUpload: (
    body: Record<string, unknown>
  ) => Promise<{ upload_param?: string; upload_full_url?: string }>;
}): Promise<WeChatUploadedMedia> {
  const started = Date.now();
  let stage: ConstructorParameters<typeof WeChatMediaUploadError>[0]['stage'] = 'validate';
  let encryptedBytes = 0;
  let attempt = 0;
  const failure = (
    reason: ConstructorParameters<typeof WeChatMediaUploadError>[0]['reason'],
    httpStatus?: number,
    error?: unknown,
    progress?: WeChatUploadProgress
  ) =>
    new WeChatMediaUploadError(
      {
        stage,
        reason,
        bytes: params.fileData.length,
        encryptedBytes,
        elapsedMs: Date.now() - started,
        httpStatus,
        attempt,
        ...(progress ? { phases: { phase: progress.phase, writtenBytes: progress.writtenBytes, ...(progress.connectMs !== undefined ? { connectMs: progress.connectMs } : {}), ...(progress.writeMs !== undefined ? { writeMs: progress.writeMs } : {}), ...(progress.responseMs !== undefined ? { responseMs: progress.responseMs } : {}) } } : {}),
      },
      error
    );
  try {
    if (params.fileData.length > WECHAT_MEDIA_MAX_BYTES) {
      throw failure('size');
    }
    stage = 'encrypt';
    const key = randomBytes(16);
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(params.fileData), cipher.final()]);
    const filekey = randomBytes(16).toString('hex');
    encryptedBytes = encrypted.length;
    let response: Awaited<ReturnType<typeof uploadPost>>;
    while (true) {
      attempt++;
      stage = 'negotiate';
      const spec = await params.requestUpload({
        filekey,
        to_user_id: params.to,
        media_type: params.kind === 'image' ? 1 : params.kind === 'video' ? 2 : 3,
        rawsize: params.fileData.length,
        rawfilemd5: createHash('md5').update(params.fileData).digest('hex'),
        filesize: encrypted.length,
        no_need_thumb: true,
        aeskey: key.toString('hex'),
      });
      stage = 'reference';
      if (!spec.upload_full_url && !spec.upload_param) {
        throw failure('reference');
      }
      const url = cdnUrl(
        spec.upload_full_url ||
          `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(spec.upload_param ?? '')}&filekey=${filekey}`
      );
      stage = 'upload';
      try {
        response = await uploadPost(url, encrypted, uploadDeadlineMs(encrypted.length), params.signal);
        break;
      } catch (error) {
        const progress = readProgress(error);
        const cause = safeMediaCause(error);
        // #5720 (T-101): retry only a provably pre-write failure — still in the
        // connect phase, zero ciphertext bytes handed over, caller not cancelling,
        // cause allowlisted as connect-establishment. Everything else (write
        // stall, receipt wait, HTTP, cancelled, ambiguous ECONNRESET) throws.
        const retriable =
          attempt < UPLOAD_MAX_ATTEMPTS &&
          progress?.phase === 'connect' &&
          progress.writtenBytes === 0 &&
          !params.signal?.aborted &&
          (cause?.name === 'TimeoutError' || (cause?.code !== undefined && RETRYABLE_CONNECT_CODES.has(cause.code)));
        if (!retriable) {
          throw error;
        }
        // Bounded fields only: attempt, cause code, elapsed — never URL or key material.
        logger.warn(
          { attempt, nextAttempt: attempt + 1, cause: cause?.code ?? cause?.name, elapsedMs: Date.now() - started },
          'WeChat CDN upload failed before any bytes were sent; renegotiating upload and retrying once'
        );
      }
    }
    const receiptHeader = response.headers['x-encrypted-param'];
    const downloadParam = Array.isArray(receiptHeader) ? receiptHeader[0] : receiptHeader;
    if (response.status < 200 || response.status >= 300) {
      throw failure('http', response.status, undefined, response.progress);
    }
    stage = 'receipt';
    if (!downloadParam) {
      throw failure('receipt', undefined, undefined, response.progress);
    }
    // #5720: bounded per-phase timings on success make the healthy baseline
    // measurable against the failing one (connect vs write vs receipt).
    logger.info(
      {
        kind: params.kind, attempt, bytes: params.fileData.length, encryptedBytes,
        phase: response.progress.phase, connectMs: response.progress.connectMs,
        writeMs: response.progress.writeMs, responseMs: response.progress.responseMs,
        diagnosticId: randomUUID().slice(0, 8),
      },
      'WeChat CDN upload completed'
    );
    return {
      media: {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(key.toString('hex')).toString('base64'),
        encrypt_type: 1,
      },
      size: params.fileData.length,
      encryptedSize: encrypted.length,
    };
  } catch (error) {
    if (error instanceof WeChatMediaUploadError) {
      logUploadFailure(error);
      throw error;
    }
    const cause = safeMediaCause(error);
    const reason =
      stage === 'reference'
        ? 'reference'
        : stage === 'negotiate'
          ? 'negotiate'
          : stage !== 'upload'
            ? 'local'
            : cause?.name === 'TimeoutError' ||
                cause?.code?.includes('TIMEOUT') ||
                cause?.code === 'ETIMEDOUT'
              ? 'timeout'
              : cause?.name === 'AbortError'
                ? 'cancelled'
                : 'network';
    const terminal = failure(reason, undefined, error, readProgress(error));
    logUploadFailure(terminal);
    throw terminal;
  }
}

function aesKey(encoded: string): Buffer {
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString())) {
    return Buffer.from(decoded.toString(), 'hex');
  }
  throw new Error('Invalid WeChat media encryption key');
}

/** Keep the private attachment cache bounded: 7 days, 200 files, 256 MiB. */
async function pruneMedia(dir: string): Promise<void> {
  const entries = await Promise.all(
    (await fs.readdir(dir)).map(async (name) => ({ name, stat: await fs.lstat(join(dir, name)) }))
  );
  let bytes = 0;
  let count = 0;
  for (const entry of entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
    if (!entry.stat.isFile()) {
      continue;
    }
    bytes += entry.stat.size;
    count++;
    if (
      count > 200 ||
      bytes > 256 * 1024 * 1024 ||
      entry.stat.mtimeMs < Date.now() - 7 * 86_400_000
    ) {
      await fs.rm(join(dir, entry.name), { force: true });
    }
  }
}

/** Download/decrypt into the common channel's local attachment abstraction. */
export async function downloadWeChatMedia(
  item: WeChatImageItem | WeChatFileItem,
  dir: string,
  signal?: AbortSignal
): Promise<NonNullable<IncomingMessage['attachments']>[number]> {
  const started = Date.now();
  let stage: 'reference' | 'fetch' | 'read' | 'decrypt' | 'write' = 'reference';
  let size = 0;
  const failure = (
    reason: ConstructorParameters<typeof WeChatMediaError>[0]['reason'],
    httpStatus?: number,
    error?: unknown
  ) =>
    new WeChatMediaError(
      { stage, reason, elapsedMs: Date.now() - started, bytes: size, httpStatus },
      error
    );
  try {
    const payload = item.type === 2 ? item.image_item : item.file_item;
    const { media } = payload;
    const source =
      media?.full_url ||
      (media?.encrypt_query_param
        ? `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
        : payload.url);
    if (!source) {
      throw failure('reference');
    }
    const url = cdnUrl(source);
    stage = 'fetch';
    const response = await fetch(url, { signal: mediaSignal(signal), redirect: 'error' });
    if (
      !response.ok ||
      Number(response.headers.get('content-length') ?? 0) > WECHAT_MEDIA_MAX_BYTES + 16
    ) {
      await response.body?.cancel();
      throw failure(response.ok ? 'size' : 'http', response.status);
    }
    stage = 'read';
    const reader = response.body?.getReader();
    if (!reader) {
      throw failure('empty');
    }
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        size += chunk.value.length;
        if (size > WECHAT_MEDIA_MAX_BYTES + 16) {
          throw failure('size');
        }
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let data = Buffer.concat(chunks);
    stage = 'decrypt';
    const imageKey = item.type === 2 ? item.image_item.aeskey : undefined;
    const encodedKey = imageKey ? Buffer.from(imageKey, 'hex').toString('base64') : media?.aes_key;
    if (encodedKey) {
      let key: Buffer;
      try {
        key = aesKey(encodedKey);
      } catch (error) {
        throw failure('key', undefined, error);
      }
      try {
        const decipher = createDecipheriv('aes-128-ecb', key, null);
        data = Buffer.concat([decipher.update(data), decipher.final()]);
      } catch (error) {
        throw failure('decrypt', undefined, error);
      }
    } else if (media?.encrypt_query_param || media?.encrypt_type) {
      throw failure('key');
    }
    if (data.length > WECHAT_MEDIA_MAX_BYTES) {
      throw failure('size');
    }
    const imageMime = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      ? 'image/png'
      : data[0] === 0xff && data[1] === 0xd8
        ? 'image/jpeg'
        : undefined;
    const original =
      item.type === 4
        ? (item.file_item.file_name ?? 'file.bin')
        : `image.${imageMime === 'image/png' ? 'png' : imageMime === 'image/jpeg' ? 'jpg' : 'bin'}`;
    const fileName =
      basename(original.replaceAll('\\', '/'))
        .replace(/[\x00-\x1f]/g, '_')
        .slice(-180) || 'file.bin';
    stage = 'write';
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(dir)).isDirectory()) {
      throw new Error('Invalid WeChat attachment directory');
    }
    await fs.chmod(dir, 0o700);
    const filePath = join(dir, `${randomUUID()}-${fileName}`);
    await fs.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
    await pruneMedia(dir);
    return {
      fileName,
      filePath,
      size: data.length,
      mimeType: item.type === 2 ? imageMime : undefined,
    };
  } catch (error) {
    if (error instanceof WeChatMediaError) {
      throw error;
    }
    throw failure(
      signal?.aborted
        ? 'cancelled'
        : stage === 'reference'
          ? 'host'
          : stage === 'decrypt'
            ? 'decrypt'
            : stage === 'write'
              ? 'write'
              : 'network',
      undefined,
      error
    );
  }
}
