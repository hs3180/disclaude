/** Protocol integration only: Tencent HTTP is intercepted; the Agent handoff is simulated. */
import { describe, it, expect, vi } from 'vitest';
import { createCipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import nock from 'nock';
import { WeChatChannel } from '../../packages/service/src/channels/wechat/wechat-channel.js';
import { WeChatStateStore } from '../../packages/service/src/channels/wechat/state-store.js';
import { WECHAT_WIRED_DESCRIPTOR } from '../../packages/service/src/channels/wired-descriptors.js';
import { HttpApiServer } from '../../packages/service/src/http-api-server.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const peer = 'integration-user@im.wechat';

describe('WeChat channel protocol integration', () => {
  it('routes decrypted mixed attachments through common wiring, replies with private context, and restores dedup after restart', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-channel-e2e-'));
    const store = new WeChatStateStore(dir);
    let channel = new WeChatChannel({ stateDir: dir });
    let polls = 0;
    let replay!: () => void;
    const replayed = new Promise<void>(resolve => { replay = resolve; });
    let admitted!: () => void;
    const received = new Promise<void>(resolve => { admitted = resolve; });
    const file = Buffer.from('user file contents');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=', 'base64');
    const key = Buffer.from('0123456789abcdef');
    const encrypt = (data: Buffer) => { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); };
    const media = (ref: string) => ({ encrypt_query_param: ref, aes_key: key.toString('base64') });
    const update = { message_id: '18446744073709551615', from_user_id: peer, message_type: 1, create_time_ms: Date.now(), context_token: 'private-context', item_list: [
      { type: 1, text_item: { text: 'hello' } },
      { type: 2, image_item: { media: media('image-ref') } },
      { type: 4, file_item: { media: media('file-ref'), file_name: '../notes.txt' } },
    ] };
    nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query({ encrypted_query_param: 'image-ref' }).reply(200, encrypt(image));
    nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query({ encrypted_query_param: 'file-ref' }).reply(200, encrypt(file));
    nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getconfig').reply(200, { ret: 0, typing_ticket: 'ticket' });
    nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/sendtyping').reply(200, { ret: 0 });
    nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getupdates').reply(() => {
      polls++;
      if (polls === 2) { replay(); }
      return polls === 3 || polls >= 5 ? [200, { ret: -14 }] : [200, { ret: 0, msgs: [update, { ...update, message_id: 'echo', message_type: 2 }], get_updates_buf: 'accepted-cursor' }];
    });
    const sent = nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/sendmessage', body => body.msg.to_user_id === peer && body.msg.context_token === 'private-context' && body.msg.item_list[0].text_item.text === 'agent reply').reply(200, { ret: 0, message_id: 'server-reply-id' });
    const route = vi.fn(async (message) => {
      expect(message.attachments).toHaveLength(2);
      expect(await fs.readFile(message.attachments[0].localPath)).toEqual(image);
      expect(await fs.readFile(message.attachments[1].localPath)).toEqual(file);
      expect(JSON.stringify(message)).not.toContain('private-context');
      expect(await callbacks(peer).sendMessage(peer, 'agent reply', message.messageId)).toBe('server-reply-id');
      admitted();
    });
    let callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never);
    const wire = () => {
      callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never);
      channel.onMessage(WECHAT_WIRED_DESCRIPTOR.createMessageHandler(channel, { logger, callbacks, inputMessageRouter: { route } } as never));
    };
    try {
      await store.saveCredentials({ token: 'test-token', botId: 'bot', userId: peer, baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
      wire(); await channel.start();
      await received; await replayed;
      await vi.waitFor(() => expect(channel.getMessageListener()?.isListening()).toBe(false));
      await channel.stop();
      expect(sent.isDone()).toBe(true);
      expect(route).toHaveBeenCalledTimes(1);
      expect(await store.loadSession('bot')).toMatchObject({ cursor: 'accepted-cursor', seenMessageIds: [update.message_id], contexts: { [peer]: 'private-context' } });
      channel = new WeChatChannel({ stateDir: dir }); wire(); await channel.start();
      expect(channel.ownsChatId(peer)).toBe(true);
      expect(channel.ownsChatId('unrelated-session')).toBe(false);
      await vi.waitFor(() => expect(channel.getMessageListener()?.isListening()).toBe(false));
      await channel.stop();
      expect(route).toHaveBeenCalledTimes(1);
    } finally { await channel.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('discovers WeChat capabilities through the real installed CLI and an authenticated local API', async () => {
    nock.enableNetConnect('127.0.0.1');
    const server = new HttpApiServer({ host: '127.0.0.1', port: 0, apiToken: 'capability-test-token' });
    const channel = new WeChatChannel();
    server.setChannelCapabilitiesProvider(chatId => !chatId || chatId === peer ? [{ id: channel.id, name: channel.name, status: channel.status, healthy: channel.isHealthy(), capabilities: channel.getCapabilities() }] : []);
    try {
      await server.start();
      const address = server.getAddress();
      if (!address) { throw new Error('API did not start'); }
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/api/channel-capabilities`, { method: 'POST', body: '{}' })).status).toBe(401);
      const result = await promisify(execFile)(process.execPath, ['bin/disclaude.js', 'channel', 'capabilities', '--chat', peer], { env: { ...process.env, DISCLAUDE_API_BASE_URL: base, DISCLAUDE_API_TOKEN: 'capability-test-token' } });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, channels: [{ id: 'wechat', capabilities: { supportsFile: true, supportsCard: false, supportedChannelTools: ['send_text', 'send_file'] } }] });
    } finally { await server.stop(); }
  });
});
