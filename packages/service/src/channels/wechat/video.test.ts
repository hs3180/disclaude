import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { WeChatChannel } from './wechat-channel.js';
import { WeChatApiClient } from './api-client.js';
import { WECHAT_MEDIA_MAX_BYTES } from './media.js';

const peer = 'video-user@im.wechat';
afterEach(() => { nock.cleanAll(); vi.restoreAllMocks(); });

describe('native WeChat video delivery', () => {
  it('uploads MP4 ciphertext as media_type=2 and sends type=5 with ciphertext size and original context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-video-'));
    const channel = new WeChatChannel({ token: 'test-token' });
    const filePath = join(dir, 'CLIP.MP4');
    const plaintext = Buffer.from('local test MP4 bytes; protocol fixture only');
    const privateState = channel as unknown as { contexts: Map<string, string> };
    privateState.contexts.set(peer, 'video-context');
    nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/getupdates').reply(200, { ret: -14 });
    let key: Buffer;
    let encryptedSize = 0;
    const negotiate = nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/getuploadurl', body => {
      expect(body).toMatchObject({ media_type: 2, to_user_id: peer, rawsize: plaintext.length, no_need_thumb: true });
      key = Buffer.from(body.aeskey, 'hex'); encryptedSize = body.filesize; return true;
    }).reply(200, { ret: 0, upload_param: 'upload-video' });
    const upload = nock('https://novac2c.cdn.weixin.qq.com').post('/c2c/upload', body => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'hex');
      const decipher = createDecipheriv('aes-128-ecb', key, null);
      expect(Buffer.concat([decipher.update(bytes), decipher.final()])).toEqual(plaintext);
      expect(bytes.length).toBe(encryptedSize); return true;
    }).query(true).reply(200, '', { 'x-encrypted-param': 'video-reference' });
    const send = nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/sendmessage', body => {
      expect(body.msg).toMatchObject({ to_user_id: peer, context_token: 'video-context', item_list: [{ type: 5, video_item: { video_size: encryptedSize, media: { encrypt_query_param: 'video-reference', encrypt_type: 1 } } }] });
      expect(body.msg.item_list[0]).not.toHaveProperty('file_item'); return true;
    }).reply(200, { ret: 0, message_id: 'video-server-id' });
    try {
      await writeFile(filePath, plaintext); await channel.start();
      await vi.waitFor(() => expect(channel.getMessageListener()?.isListening()).toBe(false));
      await expect(channel.sendMessage({ chatId: peer, type: 'file', filePath })).resolves.toBe('video-server-id');
      expect(negotiate.isDone() && upload.isDone() && send.isDone()).toBe(true);
      expect(channel.getCapabilities().nativeVideoFormats).toEqual(['mp4']);
    } finally { await channel.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it('does not retry an unknown video delivery or silently send a file instead', async () => {
    const api = new WeChatApiClient({ baseUrl: 'https://ilinkai.weixin.qq.com', token: 'test-token' });
    const send = nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/sendmessage', body => body.msg.item_list[0].type === 5).replyWithError('network lost after submission');
    await expect(api.sendVideo({ to: peer, uploaded: { size: 7, encryptedSize: 16, media: { encrypt_query_param: 'private', aes_key: 'private' } }, contextToken: 'ctx' })).rejects.toThrow(/unknown/i);
    expect(send.isDone()).toBe(true);
  });

  it.each(['oversize', 'upload failure'])('reports %s without sending a video or falling back to a file', async reason => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-video-error-'));
    const channel = new WeChatChannel({ token: 'test-token' });
    const filePath = join(dir, 'clip.mp4');
    (channel as unknown as { contexts: Map<string, string> }).contexts.set(peer, 'context');
    nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/getupdates').reply(200, { ret: -14 });
    try {
      await writeFile(filePath, 'protocol fixture');
      if (reason === 'oversize') { await truncate(filePath, WECHAT_MEDIA_MAX_BYTES + 1); }
      else { nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/getuploadurl', body => body.media_type === 2).reply(500, {}); }
      await channel.start();
      await vi.waitFor(() => expect(channel.getMessageListener()?.isListening()).toBe(false));
      const api = channel.getApiClient(); if (!api) { throw new Error('Missing client'); }
      const video = vi.spyOn(api, 'sendVideo'); const file = vi.spyOn(api, 'sendFile');
      await expect(channel.sendMessage({ chatId: peer, type: 'file', filePath })).rejects.toThrow(reason === 'oversize' ? /20 MiB/ : /500/);
      expect(video).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled();
    } finally { await channel.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});
