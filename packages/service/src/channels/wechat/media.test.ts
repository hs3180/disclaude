import { afterEach, describe, it, expect, vi } from 'vitest';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { downloadWeChatMedia, uploadEncryptedMedia } from './media.js';

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
