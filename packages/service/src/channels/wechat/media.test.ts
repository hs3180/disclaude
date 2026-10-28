import { afterEach, describe, it, expect, vi } from 'vitest';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { downloadWeChatMedia, uploadEncryptedMedia, WECHAT_MEDIA_MAX_BYTES } from './media.js';
import { channelError } from '../../channel-error.js';

afterEach(() => { vi.restoreAllMocks(); nock.cleanAll(); });

describe('WeChat encrypted CDN protocol', () => {
  it('keeps fetch cause codes without retaining signed URLs, keys or raw error text', async () => {
    const raw = new TypeError('private-signed-url?token=private-value', { cause: Object.assign(new Error('private-inner'), { code: 'ECONNRESET' }) });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(raw);
    const error = await downloadWeChatMedia({ type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/private?signature=private-ref', aes_key: 'private-key' } } }, '/unused').catch(error => error);
    expect(error).toMatchObject({ name: 'WeChatMediaError', retryable: true, cause: { name: 'TypeError', code: 'ECONNRESET' },
      detail: { stage: 'fetch', reason: 'network', diagnosticId: expect.any(String), elapsedMs: expect.any(Number) } });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/private-|signature=|token=/);
  });

  it.each([403, 503])('classifies HTTP %s without reading its private response body', async status => {
    nock('https://novac2c.cdn.weixin.qq.com').get('/failure').reply(status, 'private-response-body');
    const error = await downloadWeChatMedia({ type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/failure' } }, '/unused').catch(error => error);
    expect(error.detail).toMatchObject({ stage: 'fetch', reason: 'http', httpStatus: status, retryable: status === 503 });
    expect(JSON.stringify(error)).not.toContain('private-response-body');
  });

  it('distinguishes failed body reads, oversized streams, decryption and disk failures', async () => {
    const url = { type: 2 as const, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/image' } };
    const response = new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('private-read'), { code: 'UND_ERR_SOCKET' })); } }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    await expect(downloadWeChatMedia(url, '/unused')).rejects.toMatchObject({ detail: { stage: 'read', reason: 'network', cause: { code: 'UND_ERR_SOCKET' } } });
    fetch.mockResolvedValueOnce(new Response('', { headers: { 'content-length': '99999999' } }));
    await expect(downloadWeChatMedia(url, '/unused')).rejects.toMatchObject({ retryable: false, detail: { reason: 'size' } });
    fetch.mockResolvedValueOnce(new Response('invalid ciphertext'));
    await expect(downloadWeChatMedia({ type: 2, image_item: { ...url.image_item, aeskey: '0123456789abcdef0123456789abcdef' } }, '/unused')).rejects.toMatchObject({ detail: { stage: 'decrypt', reason: 'decrypt' } });
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-media-error-'));
    try {
      const file = join(dir, 'file'); await fs.writeFile(file, 'not a directory');
      fetch.mockResolvedValueOnce(new Response('plain image'));
      const error = await downloadWeChatMedia(url, file).catch(error => error);
      expect(error).toMatchObject({ detail: { stage: 'write', reason: 'write' } });
      expect(JSON.stringify(error)).not.toContain(dir);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('distinguishes missing references/keys and caller cancellation', async () => {
    await expect(downloadWeChatMedia({ type: 2, image_item: {} }, '/unused')).rejects.toMatchObject({ detail: { stage: 'reference', reason: 'reference' }, retryable: false });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('encrypted'));
    await expect(downloadWeChatMedia({ type: 2, image_item: { media: { encrypt_query_param: 'private-ref', encrypt_type: 1 } } }, '/unused')).rejects.toMatchObject({ detail: { reason: 'key' }, retryable: false });
    const abort = new AbortController(); abort.abort();
    fetch.mockRejectedValueOnce(new DOMException('private-cancel', 'AbortError'));
    await expect(downloadWeChatMedia({ type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/image' } }, '/unused', abort.signal)).rejects.toMatchObject({ detail: { reason: 'cancelled' }, retryable: false });
  });

  it('uploads ciphertext and supplies a decryptable reference without leaking keys into attachment metadata', async () => {
    const plaintext = Buffer.from('a real attachment');
    let key: Buffer;
    const cdn = nock('https://novac2c.cdn.weixin.qq.com').post('/c2c/upload').query(true).reply(200, (_uri, body) => {
      const encrypted = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'hex');
      const decipher = createDecipheriv('aes-128-ecb', key, null);
      expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(plaintext);
      return '';
    }, { 'x-encrypted-param': 'download-reference' });
    const uploaded = await uploadEncryptedMedia({ fileData: plaintext, to: 'peer', kind: 'file', requestUpload: (body) => {
      expect(body).toMatchObject({ rawsize: plaintext.length, media_type: 3, to_user_id: 'peer' });
      key = Buffer.from(body.aeskey as string, 'hex');
      return Promise.resolve({ upload_param: 'upload-reference' });
    } });
    expect(uploaded.media.encrypt_query_param).toBe('download-reference');
    expect(uploaded.size).toBe(plaintext.length);
    expect(cdn.isDone()).toBe(true);
  });

  it('preserves a fast failure at the incident byte count without exposing URL, keys or raw cause', async () => {
    const fileData = Buffer.alloc(15_481_288); // Synthetic transport bytes; no real video generation.
    let key!: string;
    const requestUpload = vi.fn((body: Record<string, unknown>) => { key = body.aeskey as string; return Promise.resolve({ upload_param: 'private-upload-ref' }); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('private-signed-url', {
      cause: Object.assign(new Error('private-network-detail'), { code: 'ECONNRESET', token: 'private-token' }),
    }));
    const error = await uploadEncryptedMedia({ fileData, to: 'private-peer', kind: 'video', requestUpload }).catch(error => error);
    expect(error).toMatchObject({ name: 'WeChatMediaUploadError', cause: { name: 'TypeError', code: 'ECONNRESET' }, detail: {
      stage: 'upload', reason: 'network', bytes: fileData.length, encryptedBytes: 15_481_296, attempt: 1, messageSent: false,
    } });
    const publicFailure = channelError(error);
    expect(publicFailure.body.ok).toBe(false);
    expect(publicFailure.body.message).toContain('ECONNRESET');
    expect(publicFailure.body.message).toContain(error.detail.diagnosticId);
    expect(`${error.stack} ${JSON.stringify(error)} ${JSON.stringify(publicFailure)}`).not.toMatch(/private-|signature=|token=/);
    expect(JSON.stringify(error)).not.toContain(key);
    expect(requestUpload).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['TimeoutError', undefined, 'timeout'], ['AbortError', undefined, 'cancelled'],
    ['TypeError', 'CERT_HAS_EXPIRED', 'network'], ['TypeError', 'UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ])('distinguishes upload %s/%s failures (%s)', async (name, code, reason) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(Object.assign(new Error('private-failure'), { name, cause: { code } }));
    await expect(uploadEncryptedMedia({ fileData: Buffer.from('fixture'), to: 'peer', kind: 'file',
      requestUpload: () => Promise.resolve({ upload_param: 'private-upload-ref' }),
    })).rejects.toMatchObject({ detail: { stage: 'upload', reason, messageSent: false }, cause: { name, ...(code ? { code } : {}) } });
  });

  it.each([403, 503])('retains upload HTTP %s without reading its response body', async status => {
    const response = new Response('private-response-body', { status });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    const error = await uploadEncryptedMedia({ fileData: Buffer.from('fixture'), to: 'peer', kind: 'file',
      requestUpload: () => Promise.resolve({ upload_param: 'private-ref' }),
    }).catch(error => error);
    expect(error.detail).toMatchObject({ stage: 'upload', reason: 'http', httpStatus: status, messageSent: false });
    expect(response.bodyUsed).toBe(true);
    expect(JSON.stringify(error)).not.toContain('private-response-body');
  });

  it('distinguishes negotiation, URL validation, receipt and size failures without sending a message', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const requestUpload = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private-negotiation'), { code: -14, detail: { httpStatus: 401, token: 'private-token' } }));
    const params = { fileData: Buffer.from('fixture'), to: 'peer', kind: 'file' as const, requestUpload };
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({ authExpired: true, detail: { stage: 'negotiate', reason: 'negotiate', httpStatus: 401, apiCode: -14 } });
    requestUpload.mockResolvedValueOnce({});
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({ detail: { stage: 'reference', reason: 'reference' } });
    requestUpload.mockResolvedValueOnce({ upload_full_url: 'http://127.0.0.1/private?secret=private-value' });
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({ detail: { stage: 'reference', reason: 'reference' } });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response('private-response-body'));
    requestUpload.mockResolvedValueOnce({ upload_param: 'private-ref' });
    await expect(uploadEncryptedMedia(params)).rejects.toMatchObject({ detail: { stage: 'receipt', reason: 'receipt' } });
    requestUpload.mockClear(); fetch.mockClear();
    await expect(uploadEncryptedMedia({ ...params, fileData: Buffer.alloc(WECHAT_MEDIA_MAX_BYTES + 1) })).rejects.toMatchObject({ detail: { stage: 'validate', reason: 'size', encryptedBytes: 0 } });
    expect(requestUpload).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('decrypts both key encodings and sanitizes inbound file names', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-media-'));
    try {
      for (const encodeHex of [false, true]) {
        const key = Buffer.from('0123456789abcdef');
        const cipher = createCipheriv('aes-128-ecb', key, null);
        const plaintext = Buffer.from('attachment content');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query({ encrypted_query_param: 'private-ref' }).reply(200, ciphertext);
        const attachment = await downloadWeChatMedia({ type: 4, file_item: { file_name: '../../secret.txt', media: { encrypt_query_param: 'private-ref', aes_key: (encodeHex ? Buffer.from(key.toString('hex')) : key).toString('base64') } } }, dir);
        expect(attachment.fileName).toBe('secret.txt');
        expect(await fs.readFile(attachment.filePath)).toEqual(plaintext);
        expect((await fs.stat(attachment.filePath)).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(attachment)).not.toContain('private-ref');
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('rejects unsafe hosts and oversized responses before saving an attachment', async () => {
    await expect(downloadWeChatMedia({ type: 2, image_item: { url: 'http://127.0.0.1/private' } }, '/unused')).rejects.toThrow('Unsupported');
    nock('https://novac2c.cdn.weixin.qq.com').get('/large').reply(200, '', { 'content-length': '99999999' });
    await expect(downloadWeChatMedia({ type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/large' } }, '/unused')).rejects.toThrow('20 MiB');
  });
});
