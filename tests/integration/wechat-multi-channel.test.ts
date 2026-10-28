/** Real adapters/lifecycle/HTTP CLI; Tencent and Feishu gateways are simulated. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import nock from 'nock';
import { BaseChannel, type IncomingMessage, type OutgoingMessage } from '@disclaude/core';
import { WeChatChannel } from '../../packages/service/src/channels/wechat/wechat-channel.js';
import { WeChatStateStore } from '../../packages/service/src/channels/wechat/state-store.js';
import { WECHAT_WELCOME_TEXT } from '../../packages/service/src/channels/wechat/welcome.js';
import { REST_WIRED_DESCRIPTOR, WECHAT_WIRED_DESCRIPTOR } from '../../packages/service/src/channels/wired-descriptors.js';
import { DisclaudeService } from '../../packages/service/src/service.js';
import { ChannelLifecycleManager } from '../../packages/service/src/channel-lifecycle-manager.js';
import { createChannelApiHandlers } from '../../packages/service/src/utils/channel-handlers.js';
import { HttpApiServer } from '../../packages/service/src/http-api-server.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const peer = 'wechat-user@im.wechat';
class SimulatedFeishu extends BaseChannel {
  sent: OutgoingMessage[] = [];
  constructor() { super({}, 'feishu', 'Simulated Feishu'); }
  protected doStart() { return Promise.resolve(); }
  protected doStop() { return Promise.resolve(); }
  protected doSendMessage(message: OutgoingMessage) { this.sent.push(message); return Promise.resolve('feishu-reply'); }
  protected checkHealth() { return true; }
  ownsChatId(chatId: string) { return chatId.startsWith('oc_'); }
}
afterEach(() => { nock.cleanAll(); vi.restoreAllMocks(); });

function setupService(received: IncomingMessage[] = []) {
  const service = new DisclaudeService();
  const manager = service.getChannelManager();
  const context = { logger, service, controlHandler: vi.fn(), controlHandlerContext: {},
    agentPool: { getPoolStats: vi.fn(() => ({})), getOrCreateChatAgent: vi.fn() },
    inputMessageRouter: { route: vi.fn(async (message: IncomingMessage) => { received.push(message); }) },
  };
  const lifecycle = new ChannelLifecycleManager(manager, context as never);
  const feishu = new SimulatedFeishu();
  manager.register(feishu);
  const feishuHandlers = { ...createChannelApiHandlers(feishu, { logger, channelName: 'Feishu' } as never), sendInteractive: () => Promise.reject(new Error('simulated')) };
  service.registerFeishuHandlers(feishuHandlers);
  service.registerChannelHandlers('feishu', feishuHandlers, feishu);
  return { service, manager, lifecycle, feishu };
}

describe('one-process Feishu, REST and single-WeChat routing', () => {
  it('keeps Feishu and REST serving when the WeChat login is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-startup-isolation-'));
    const { service, manager, lifecycle, feishu } = setupService();
    try {
      await lifecycle.createAndWire(REST_WIRED_DESCRIPTOR, { port: 0, host: '127.0.0.1', fileStorageDir: join(dir, 'rest') });
      await lifecycle.createAndWire(WECHAT_WIRED_DESCRIPTOR, { stateDir: join(dir, 'no-login') });
      await lifecycle.startAll();
      expect(manager.get('wechat')?.status).toBe('error');
      expect(feishu.isHealthy()).toBe(true);
      expect(manager.get('rest')?.isHealthy()).toBe(true);
      await service.sendMessage('oc_simulated_feishu', 'still available');
      expect(feishu.sent.map(message => message.text)).toEqual(['still available']);
      await expect(service.sendMessage(peer, 'unavailable')).rejects.toThrow('No registered channel owns');
      expect(feishu.sent).toHaveLength(1);
    } finally { await lifecycle.stopAll(); await rm(dir, { recursive: true, force: true }); }
  });

  it('routes replies and native video to the single WeChat owner and restores ownership/dedup after restart', async () => {
    nock.enableNetConnect('127.0.0.1');
    const dir = await mkdtemp(join(tmpdir(), 'wechat-multi-channel-'));
    const received: IncomingMessage[] = [];
    const { service, manager, lifecycle, feishu } = setupService(received);
    const stateDir = join(dir, 'wechat');
    const baseUrl = 'https://coexist.weixin.qq.com';
    const store = new WeChatStateStore(stateDir);
    let polls = 0;
    const api = new HttpApiServer({ port: 0, host: '127.0.0.1', apiToken: 'coexist-test-token' });
    try {
      await lifecycle.createAndWire(REST_WIRED_DESCRIPTOR, { port: 0, host: '127.0.0.1', fileStorageDir: join(dir, 'rest') });
      await store.saveCredentials({ token: 'test-wechat', botId: 'coexist-bot', baseUrl, savedAt: new Date().toISOString() });
      nock(baseUrl).persist().post('/ilink/bot/getconfig').reply(200, { ret: 0, typing_ticket: 'ticket' });
      nock(baseUrl).persist().post('/ilink/bot/sendtyping').reply(200, { ret: 0 });
      const welcome = nock(baseUrl).post('/ilink/bot/sendmessage', body => body.msg.to_user_id === peer
        && body.msg.context_token === 'private-context' && body.msg.item_list[0].text_item.text === WECHAT_WELCOME_TEXT)
        .reply(200, { ret: 0, message_id: 'welcome-ack' });
      nock(baseUrl).persist().post('/ilink/bot/getupdates').reply((_uri, _body, callback) => {
        polls++;
        if (polls % 2 === 1) {
          callback(null, [200, { ret: 0, get_updates_buf: 'saved-cursor', msgs: [{ message_id: 'gateway-id', from_user_id: peer, message_type: 1,
            context_token: 'private-context', item_list: [{ type: 1, text_item: { text: 'hello-wechat' } }] }] }]);
        }
        // An outstanding long poll has no delayed reply to race its abort.
      });
      await lifecycle.createAndWire(WECHAT_WIRED_DESCRIPTOR, { stateDir });
      await lifecycle.startAll();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0].chatId).toBe(peer);
      expect(received[0].messageId).toBe('gateway-id');
      expect(JSON.stringify(received)).not.toContain('private-context');
      expect(feishu.isHealthy()).toBe(true);
      expect(manager.get('rest')?.isHealthy()).toBe(true);
      const sent = nock(baseUrl).post('/ilink/bot/sendmessage', body => {
        expect(body.msg).toMatchObject({ to_user_id: peer, context_token: 'private-context' }); return body.msg.item_list[0].text_item.text === 'wechat reply';
      }).reply(200, { ret: 0, message_id: 'wechat-reply' });
      await expect(service.sendMessage(peer, 'wechat reply')).resolves.toMatchObject({ messageId: 'wechat-reply' });
      expect(sent.isDone()).toBe(true);
      await vi.waitFor(() => expect(welcome.isDone()).toBe(true));
      await expect(service.sendMessage('unknown@im.wechat', 'unknown')).rejects.toThrow('No registered channel owns');
      await expect(service.sendCard(peer, {})).rejects.toThrow('does not support cards');
      expect(feishu.sent).toHaveLength(0);
      await service.sendMessage('oc_simulated_feishu', 'feishu reply');
      expect(feishu.sent).toHaveLength(1);
      const spy = vi.spyOn(feishu, 'sendMessage');
      const routed = nock(baseUrl).post('/ilink/bot/sendmessage').reply(200, { ret: 0, message_id: 'unicast' });
      await manager.sendToChat({ chatId: peer, type: 'text', text: 'scheduled reply' });
      expect(routed.isDone()).toBe(true); expect(spy).not.toHaveBeenCalled();

      api.setChannelCapabilitiesProvider(chatId => service.getChannels().filter(c => !chatId || c.ownsChatId(chatId)).map(c => ({ id: c.id, name: c.name, status: c.status, healthy: c.isHealthy(), capabilities: c.getCapabilities() })));
      api.setUploadFileHandler((chatId, filePath, threadId) => service.uploadFile(chatId, filePath, threadId));
      await api.start(); const address = api.getAddress(); if (!address) { throw new Error('API did not bind'); }
      const result = await promisify(execFile)(process.execPath, ['bin/disclaude.js', 'channel', 'capabilities', '--chat', peer], {
        env: { ...process.env, DISCLAUDE_API_BASE_URL: `http://127.0.0.1:${address.port}`, DISCLAUDE_API_TOKEN: 'coexist-test-token' },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, channels: [{ id: 'wechat', healthy: true }] });
      const videoPath = join(dir, 'protocol-only.mp4');
      await writeFile(videoPath, 'offline native-video protocol fixture');
      const negotiate = nock(baseUrl).post('/ilink/bot/getuploadurl', body => body.media_type === 2 && body.to_user_id === peer && body.no_need_thumb === true)
        .reply(200, { ret: 0, upload_param: 'upload-video' });
      const upload = nock('https://novac2c.cdn.weixin.qq.com').post('/c2c/upload').query(true).reply(200, '', { 'x-encrypted-param': 'video-ref' });
      const video = nock(baseUrl).post('/ilink/bot/sendmessage', body => body.msg.context_token === 'private-context' && body.msg.to_user_id === peer && body.msg.item_list[0].type === 5)
        .reply(200, { ret: 0, message_id: 'native-video-id' });
      const delivery = await promisify(execFile)(process.execPath, ['bin/disclaude.js', 'channel', 'send_file', '--chat', peer, '--file', videoPath], {
        env: { ...process.env, DISCLAUDE_API_BASE_URL: `http://127.0.0.1:${address.port}`, DISCLAUDE_API_TOKEN: 'coexist-test-token' },
      });
      expect(JSON.parse(delivery.stdout).ok).toBe(true);
      expect(negotiate.isDone() && upload.isDone() && video.isDone()).toBe(true);
      expect(spy).not.toHaveBeenCalled();

      await lifecycle.stopAll();
      const before = polls;
      const restored = new WeChatChannel({ stateDir });
      restored.onMessage(async message => { received.push(message); });
      try {
        await restored.start();
        expect(restored.ownsChatId(peer)).toBe(true);
        expect(restored.ownsChatId('unknown@im.wechat')).toBe(false);
        await vi.waitFor(() => expect(polls).toBeGreaterThan(before));
        expect(received).toHaveLength(1);
        const saved = await store.loadSession('coexist-bot');
        expect(saved).toMatchObject({ cursor: 'saved-cursor', seenMessageIds: ['gateway-id'], contexts: { [peer]: 'private-context' } });
      } finally { await restored.stop(); }
    } finally { await api.stop(); await lifecycle.stopAll(); await rm(dir, { recursive: true, force: true }); }
  });
});
