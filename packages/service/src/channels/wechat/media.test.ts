import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { downloadWeChatMedia, uploadEncryptedMedia } from './media.js';

describe('WeChat encrypted CDN protocol', () => {
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
