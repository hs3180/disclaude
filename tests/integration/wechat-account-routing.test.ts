/** Real adapters and handler dispatch; Tencent HTTP is intercepted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import type { IncomingMessage } from '@disclaude/core';
import { WeChatRegistry } from '../../packages/service/src/channels/wechat/registry.js';
import { WeChatChannel } from '../../packages/service/src/channels/wechat/wechat-channel.js';
import { WeChatStateStore } from '../../packages/service/src/channels/wechat/state-store.js';
import { WECHAT_WELCOME_TEXT } from '../../packages/service/src/channels/wechat/welcome.js';
import { wechatPeer, lockWeChatIdentity } from '../../packages/service/src/channels/wechat/identity.js';
import { DisclaudeService } from '../../packages/service/src/service.js';
import { createChannelApiHandlers } from '../../packages/service/src/utils/channel-handlers.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const peer = 'shared-user@im.wechat';
afterEach(() => { nock.cleanAll(); vi.restoreAllMocks(); });

describe('registered WeChat account identity and routing', () => {
  it('isolates the same peer/message ID, replies with each account context, and unregisters handlers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registration-routing-'));
    const registry = new WeChatRegistry(dir);
    const service = new DisclaudeService();
    const received: IncomingMessage[] = [];
    const channels: WeChatChannel[] = [];
    const welcomes: ReturnType<typeof nock>[] = [];
    try {
      for (const suffix of ['a', 'b']) {
        const baseUrl = `https://${suffix}.weixin.qq.com`;
        const account = await registry.register({ botId: `${dir}-${suffix}`, token: 'private-token', baseUrl, savedAt: new Date().toISOString() });
        let delivered = false;
        nock(baseUrl).persist().post('/ilink/bot/getupdates').reply((_uri, _body, callback) => {
          if (!delivered) {
            delivered = true;
            callback(null, [200, { ret: 0, get_updates_buf: `cursor-${suffix}`, msgs: [{ message_id: 'same-message', from_user_id: peer,
              message_type: 1, context_token: `private-context-${suffix}`, item_list: [{ type: 1, text_item: { text: suffix } }] }] }]);
          }
        });
        nock(baseUrl).persist().post('/ilink/bot/getconfig').reply(200, { ret: 0, typing_ticket: 'ticket' });
        nock(baseUrl).persist().post('/ilink/bot/sendtyping').reply(200, { ret: 0 });
        welcomes.push(nock(baseUrl).post('/ilink/bot/sendmessage', body => body.msg.to_user_id === peer
          && body.msg.context_token === `private-context-${suffix}` && body.msg.item_list[0].text_item.text === WECHAT_WELCOME_TEXT)
          .reply(200, { ret: 0, message_id: `welcome-${suffix}` }));
        const channel = new WeChatChannel({ registrationId: account.id, stateDir: registry.stateDir(account) });
        channels.push(channel);
        channel.onMessage(async message => { received.push(message); });
        service.registerChannel(channel);
        service.registerChannelHandlers('wechat', { ...createChannelApiHandlers(channel, { logger, channelName: 'WeChat' } as never),
          sendInteractive: () => Promise.reject(new Error('unsupported')) }, channel);
        await channel.start();
      }
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(new Set(received.map(message => message.chatId)).size).toBe(2);
      expect(new Set(received.map(message => message.messageId)).size).toBe(2);
      expect(JSON.stringify(received)).not.toContain('private-context');
      for (const [index, suffix] of ['a', 'b'].entries()) {
        const channel = channels[index];
        const chatId = `${channel.id}:${peer}`;
        expect(channel.ownsChatId(chatId)).toBe(true);
        expect(channel.ownsChatId(peer)).toBe(false);
        expect(channel.ownsChatId(`${channels[1 - index].id}:${peer}`)).toBe(false);
        const send = nock(`https://${suffix}.weixin.qq.com`).post('/ilink/bot/sendmessage', body =>
          body.msg.to_user_id === peer && body.msg.context_token === `private-context-${suffix}` && body.msg.item_list[0].text_item.text === 'reply')
          .reply(200, { ret: 0, message_id: `reply-${suffix}` });
        await expect(service.sendMessage(chatId, 'reply')).resolves.toMatchObject({ messageId: `reply-${suffix}` });
        expect(send.isDone()).toBe(true);
        await expect(channel.sendMessage({ chatId: peer, type: 'text', text: 'unscoped' })).rejects.toThrow('conversation ID');
      }
      await expect(service.sendMessage(peer, 'ambiguous')).rejects.toThrow('No registered channel owns');
      await channels[0].stop();
      service.unregisterChannel(channels[0].id);
      await expect(service.sendMessage(`${channels[0].id}:${peer}`, 'removed')).rejects.toThrow('No registered channel owns');
      await channels[1].stop(); expect(welcomes.every(scope => scope.isDone())).toBe(true);
    } finally { await Promise.all(channels.map(channel => channel.stop())); await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects wrong scopes and competing copies of one saved identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-identity-lock-'));
    try {
      const registry = new WeChatRegistry(dir);
      const account = await registry.register({ botId: 'test-bot', token: 'test-token', baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
      const scoped = `${registry.channelId(account)}:${peer}`;
      expect(wechatPeer(scoped, account.id)).toBe(peer);
      expect(() => wechatPeer(scoped)).toThrow('conversation ID');
      expect(() => new WeChatChannel({ registrationId: '../escape' })).toThrow('registration ID');
      const release = await lockWeChatIdentity('same-bot', join(dir, 'locks'));
      try { await expect(lockWeChatIdentity('same-bot', join(dir, 'locks'))).rejects.toThrow('already in use'); }
      finally { await release(); }
      const next = await lockWeChatIdentity('same-bot', join(dir, 'locks')); await next();
      expect((await new WeChatStateStore(registry.stateDir(account)).loadCredentials())?.botId).toBe('test-bot');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
