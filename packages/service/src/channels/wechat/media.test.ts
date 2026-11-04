import { afterEach, describe, it, expect, vi } from 'vitest';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import * as https from 'node:https';
import type { ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import {
  downloadWeChatMedia,
  uploadDeadlineMs,
  uploadEncryptedMedia,
  WECHAT_MEDIA_MAX_BYTES,
} from './media.js';
import { channelError } from '../../channel-error.js';

/**
 * #5516 (T-032): the upload channel is node:https request. nock 14's
 * `replyWithError` never reaches a ClientRequest's 'error' event (its
 * interceptor layer drops it), and an ESM namespace cannot be spied on, so
 * transport failures are injected via a pass-through partial mock of
 * node:https — the same boundary the fetch suite covered by spying on fetch.
 */
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

afterEach(() => {
  vi.useRealTimers();
  // vi.restoreAllMocks() alone does not reset a vi.fn's persistent
  // implementation, so the CDN dispatch wrapper is removed explicitly.
  if (actualRequest) {
    vi.mocked(https.request).mockImplementation(actualRequest);
  }
  vi.restoreAllMocks();
  nock.cleanAll();
});

let actualRequest: typeof https.request | undefined;

/** Route only CDN upload requests to `fake`; every other https.request passes through untouched. */
function injectUploadRequest(fake: () => ClientRequest): void {
  actualRequest ??= vi.mocked(https.request).getMockImplementation() as typeof https.request;
  vi.mocked(https.request).mockImplementation(((
    url: unknown,
    options: unknown,
    callback: unknown
  ) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
    return target.includes('novac2c.cdn.weixin.qq.com')
      ? fake()
      : actualRequest!(url as never, options as never, callback as never);
  }) as unknown as typeof https.request);
}

function failUploadWith(error: Error & { code?: string }): void {
  injectUploadRequest(() => {
    const req = new EventEmitter() as unknown as ClientRequest;
    Object.assign(req, {
      end: () => {
        process.nextTick(() => req.emit('error', error));
      },
      destroy: () => {},
    });
    return req;
  });
}

function stallUpload(): void {
  injectUploadRequest(() => {
    const req = new EventEmitter() as unknown as ClientRequest;
    Object.assign(req, {
      end: () => {},
      destroy: (destroyError?: Error) => {
        req.emit('error', destroyError ?? new Error('destroyed'));
      },
    });
    return req;
  });
}

describe('WeChat encrypted CDN protocol', () => {
  it('keeps fetch cause codes without retaining signed URLs, keys or raw error text', async () => {
    const raw = new TypeError('private-signed-url?token=private-value', {
      cause: Object.assign(new Error('private-inner'), { code: 'ECONNRESET' }),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(raw);
    const error = await downloadWeChatMedia(
      {
        type: 2,
        image_item: {
          media: {
            full_url: 'https://novac2c.cdn.weixin.qq.com/private?signature=private-ref',
            aes_key: 'private-key',
          },
        },
      },
      '/unused'
    ).catch((error) => error);
    expect(error).toMatchObject({
      name: 'WeChatMediaError',
      retryable: true,
      cause: { name: 'TypeError', code: 'ECONNRESET' },
      detail: {
        stage: 'fetch',
        reason: 'network',
        diagnosticId: expect.any(String),
        elapsedMs: expect.any(Number),
      },
    });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/private-|signature=|token=/);
  });

  it.each([403, 503])(
    'classifies HTTP %s without reading its private response body',
    async (status) => {
      nock('https://novac2c.cdn.weixin.qq.com')
        .get('/failure')
        .reply(status, 'private-response-body');
      const error = await downloadWeChatMedia(
        { type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/failure' } },
        '/unused'
      ).catch((error) => error);
      expect(error.detail).toMatchObject({
        stage: 'fetch',
        reason: 'http',
        httpStatus: status,
        retryable: status === 503,
      });
      expect(JSON.stringify(error)).not.toContain('private-response-body');
    }
  );

  it('distinguishes failed body reads, oversized streams, decryption and disk failures', async () => {
    const url = {
      type: 2 as const,
      image_item: { url: 'https://novac2c.cdn.weixin.qq.com/image' },
    };
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Object.assign(new Error('private-read'), { code: 'UND_ERR_SOCKET' }));
        },
      })
    );
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    await expect(downloadWeChatMedia(url, '/unused')).rejects.toMatchObject({
      detail: { stage: 'read', reason: 'network', cause: { code: 'UND_ERR_SOCKET' } },
    });
    fetch.mockResolvedValueOnce(new Response('', { headers: { 'content-length': '99999999' } }));
    await expect(downloadWeChatMedia(url, '/unused')).rejects.toMatchObject({
      retryable: false,
      detail: { reason: 'size' },
    });
    fetch.mockResolvedValueOnce(new Response('invalid ciphertext'));
    await expect(
      downloadWeChatMedia(
        { type: 2, image_item: { ...url.image_item, aeskey: '0123456789abcdef0123456789abcdef' } },
        '/unused'
      )
    ).rejects.toMatchObject({ detail: { stage: 'decrypt', reason: 'decrypt' } });
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-media-error-'));
    try {
      const file = join(dir, 'file');
      await fs.writeFile(file, 'not a directory');
      fetch.mockResolvedValueOnce(new Response('plain image'));
      const error = await downloadWeChatMedia(url, file).catch((error) => error);
      expect(error).toMatchObject({ detail: { stage: 'write', reason: 'write' } });
      expect(JSON.stringify(error)).not.toContain(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes missing references/keys and caller cancellation', async () => {
    await expect(downloadWeChatMedia({ type: 2, image_item: {} }, '/unused')).rejects.toMatchObject(
      { detail: { stage: 'reference', reason: 'reference' }, retryable: false }
    );
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('encrypted'));
    await expect(
      downloadWeChatMedia(
        { type: 2, image_item: { media: { encrypt_query_param: 'private-ref', encrypt_type: 1 } } },
        '/unused'
      )
    ).rejects.toMatchObject({ detail: { reason: 'key' }, retryable: false });
    const abort = new AbortController();
    abort.abort();
    fetch.mockRejectedValueOnce(new DOMException('private-cancel', 'AbortError'));
    await expect(
      downloadWeChatMedia(
        { type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/image' } },
        '/unused',
        abort.signal
      )
    ).rejects.toMatchObject({ detail: { reason: 'cancelled' }, retryable: false });
  });

  it('uploads ciphertext and supplies a decryptable reference without leaking keys into attachment metadata', async () => {
    const plaintext = Buffer.from('a real attachment');
    let key: Buffer;
    const cdn = nock('https://novac2c.cdn.weixin.qq.com')
      .post('/c2c/upload')
      .query(true)
      .reply(
        200,
        (_uri, body) => {
          const encrypted = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'hex');
          const decipher = createDecipheriv('aes-128-ecb', key, null);
          expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(plaintext);
          return '';
        },
        { 'x-encrypted-param': 'download-reference' }
      );
    const uploaded = await uploadEncryptedMedia({
      fileData: plaintext,
      to: 'peer',
      kind: 'file',
      requestUpload: (body) => {
        expect(body).toMatchObject({
          rawsize: plaintext.length,
          media_type: 3,
          to_user_id: 'peer',
        });
        key = Buffer.from(body.aeskey as string, 'hex');
        return Promise.resolve({ upload_param: 'upload-reference' });
      },
    });
    expect(uploaded.media.encrypt_query_param).toBe('download-reference');
    expect(uploaded.size).toBe(plaintext.length);
    expect(cdn.isDone()).toBe(true);
  });

  it('preserves a fast failure at the incident byte count without exposing URL, keys or raw cause', async () => {
    const fileData = Buffer.alloc(15_481_288); // Synthetic transport bytes; no real video generation.
    let key!: string;
    const requestUpload = vi.fn((body: Record<string, unknown>) => {
      key = body.aeskey as string;
      return Promise.resolve({ upload_param: 'private-upload-ref' });
    });
    failUploadWith(Object.assign(new Error('private-network-detail'), { code: 'ECONNRESET' }));
    const error = await uploadEncryptedMedia({
      fileData,
      to: 'private-peer',
      kind: 'video',
      requestUpload,
    }).catch((error) => error);
    expect(error).toMatchObject({
      name: 'WeChatMediaUploadError',
      cause: { code: 'ECONNRESET' },
      detail: {
        stage: 'upload',
        reason: 'network',
        bytes: fileData.length,
        encryptedBytes: 15_481_296,
        attempt: 1,
        messageSent: false,
      },
    });
    const publicFailure = channelError(error);
    expect(publicFailure.body.ok).toBe(false);
    expect(publicFailure.body.message).toContain('ECONNRESET');
    expect(publicFailure.body.message).toContain(error.detail.diagnosticId);
    expect(`${error.stack} ${JSON.stringify(error)} ${JSON.stringify(publicFailure)}`).not.toMatch(
      /private-|signature=|token=/
    );
    expect(JSON.stringify(error)).not.toContain(key);
    expect(requestUpload).toHaveBeenCalledOnce();
  });

  it.each([
    ['TimeoutError', 'ETIMEDOUT', 'timeout'],
    ['Error', 'UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['Error', 'ECONNRESET', 'network'],
    ['Error', 'CERT_HAS_EXPIRED', 'network'],
  ])('distinguishes https.request upload %s/%s failures (%s)', async (name, code, reason) => {
    failUploadWith(
      Object.assign(Object.create(Error.prototype), { name, message: 'private-failure', code })
    );
    await expect(
      uploadEncryptedMedia({
        fileData: Buffer.from('fixture'),
        to: 'peer',
        kind: 'file',
        requestUpload: () => Promise.resolve({ upload_param: 'private-upload-ref' }),
      })
    ).rejects.toMatchObject({
      detail: { stage: 'upload', reason, messageSent: false },
      cause: { code },
    });
  });

  // #5516 (T-032): the fixed 15s mediaSignal abort covered the whole undici
  // upload; the https.request channel must budget per-byte time instead.
  it('scales the upload deadline with payload size instead of a fixed 15s signal', () => {
    expect(uploadDeadlineMs(0)).toBe(15_000);
    expect(uploadDeadlineMs(15_481_296)).toBe(15_000 + 15_481_296 * 4);
    expect(uploadDeadlineMs(15_481_296)).toBeGreaterThan(60_000);
  });

  // Real setTimeout -> req.destroy(error) chain under fake timers; the stalled
  // request must surface as reason=timeout via the TimeoutError/ETIMEDOUT mapping.
  it('aborts a stalled upload at its deadline and classifies it as a timeout', async () => {
    vi.useFakeTimers();
    try {
      stallUpload();
      const pending = uploadEncryptedMedia({
        fileData: Buffer.from('fixture'),
        to: 'peer',
        kind: 'file',
        requestUpload: () => Promise.resolve({ upload_param: 'private-ref' }),
      });
      const expectation = expect(pending).rejects.toMatchObject({
        detail: { stage: 'upload', reason: 'timeout', messageSent: false },
        cause: { name: 'TimeoutError', code: 'ETIMEDOUT' },
      });
      await vi.advanceTimersByTimeAsync(15_000 + 16 * 4 + 1_000); // padded ciphertext: 16 bytes
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([403, 503])(
    'retains upload HTTP %s without reading its response body',
    async (status) => {
      nock('https://novac2c.cdn.weixin.qq.com')
        .post('/c2c/upload')
        .query(true)
        .reply(status, 'private-response-body');
      const error = await uploadEncryptedMedia({
        fileData: Buffer.from('fixture'),
        to: 'peer',
        kind: 'file',
        requestUpload: () => Promise.resolve({ upload_param: 'private-ref' }),
      }).catch((error) => error);
      expect(error.detail).toMatchObject({
        stage: 'upload',
        reason: 'http',
        httpStatus: status,
        messageSent: false,
      });
      expect(JSON.stringify(error)).not.toContain('private-response-body');
    }
  );

  it('distinguishes negotiation, URL validation, receipt and size failures without sending a message', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); // Uploads use https.request; fetch must stay untouched.
    const requestUpload = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('private-negotiation'), {
          code: -14,
          detail: { httpStatus: 401, token: 'private-token' },
        })
      );
    const params = {
      fileData: Buffer.from('fixture'),
      to: 'peer',
      kind: 'file' as const,
      requestUpload,
    };
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({
      authExpired: true,
      detail: { stage: 'negotiate', reason: 'negotiate', httpStatus: 401, apiCode: -14 },
    });
    requestUpload.mockResolvedValueOnce({});
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({
      detail: { stage: 'reference', reason: 'reference' },
    });
    requestUpload.mockResolvedValueOnce({
      upload_full_url: 'http://127.0.0.1/private?secret=private-value',
    });
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({
      detail: { stage: 'reference', reason: 'reference' },
    });
    nock('https://novac2c.cdn.weixin.qq.com')
      .post('/c2c/upload')
      .query(true)
      .reply(200, 'private-response-body');
    requestUpload.mockResolvedValueOnce({ upload_param: 'private-ref' });
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({
      detail: { stage: 'receipt', reason: 'receipt' },
    });
    requestUpload.mockClear();
    fetch.mockClear();
    await expect(
      uploadEncryptedMedia({ ...params, fileData: Buffer.alloc(WECHAT_MEDIA_MAX_BYTES + 1) })
    ).rejects.toMatchObject({ detail: { stage: 'validate', reason: 'size', encryptedBytes: 0 } });
    expect(requestUpload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  // #5516: undici (still the download transport) reports happy-eyeballs
  // connect failures as `TypeError: fetch failed` with an AggregateError
  // cause. Without walking `errors`, the underlying code was dropped and the
  // failure surfaced as a code-less generic error.
  it('surfaces the underlying code from an undici happy-eyeballs AggregateError at the incident byte count', async () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443 - private-address'), {
          code: 'ECONNREFUSED',
        }),
        new Error('connect ENETUNREACH private-address'),
      ],
      'private-connect-detail'
    );
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: aggregate }));
    const error = await downloadWeChatMedia(
      { type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/private' } },
      '/unused'
    ).catch((error) => error);
    expect(error).toMatchObject({
      name: 'WeChatMediaError',
      cause: { name: 'TypeError', code: 'ECONNREFUSED' },
      detail: { stage: 'fetch', reason: 'network' },
    });
    expect(error.message).not.toContain('ECONNREFUSED'); // download errors stay terse; upload ones name the code
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(
      /private-|token=|203\.0\.113/
    );
    fetch.mockRestore();
  });

  it.each(['UND_ERR_REQ_RETRY', 'EHOSTUNREACH', 'ECONNABORTED'])(
    'keeps undici/network code %s from the fetch cause chain',
    async (code) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new TypeError('private-transport-detail', {
          cause: Object.assign(new Error('private-inner'), { code }),
        })
      );
      await expect(
        downloadWeChatMedia(
          { type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/private' } },
          '/unused'
        )
      ).rejects.toMatchObject({
        detail: { stage: 'fetch', reason: 'network', cause: { name: 'TypeError', code } },
      });
      fetch.mockRestore();
    }
  );

  it('decrypts both key encodings and sanitizes inbound file names', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-media-'));
    try {
      for (const encodeHex of [false, true]) {
        const key = Buffer.from('0123456789abcdef');
        const cipher = createCipheriv('aes-128-ecb', key, null);
        const plaintext = Buffer.from('attachment content');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        nock('https://novac2c.cdn.weixin.qq.com')
          .get('/c2c/download')
          .query({ encrypted_query_param: 'private-ref' })
          .reply(200, ciphertext);
        const attachment = await downloadWeChatMedia(
          {
            type: 4,
            file_item: {
              file_name: '../../secret.txt',
              media: {
                encrypt_query_param: 'private-ref',
                aes_key: (encodeHex ? Buffer.from(key.toString('hex')) : key).toString('base64'),
              },
            },
          },
          dir
        );
        expect(attachment.fileName).toBe('secret.txt');
        expect(await fs.readFile(attachment.filePath)).toEqual(plaintext);
        expect((await fs.stat(attachment.filePath)).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(attachment)).not.toContain('private-ref');
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe hosts and oversized responses before saving an attachment', async () => {
    await expect(
      downloadWeChatMedia({ type: 2, image_item: { url: 'http://127.0.0.1/private' } }, '/unused')
    ).rejects.toThrow('Unsupported');
    nock('https://novac2c.cdn.weixin.qq.com')
      .get('/large')
      .reply(200, '', { 'content-length': '99999999' });
    await expect(
      downloadWeChatMedia(
        { type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/large' } },
        '/unused'
      )
    ).rejects.toThrow('20 MiB');
  });
});
