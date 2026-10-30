import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from '@disclaude/core';
import { WeChatChannel } from './wechat-channel.js';
import { WeChatStateStore } from './state-store.js';
import { WeChatApiClient } from './api-client.js';
import { WECHAT_WELCOME_TEXT, type WeChatWelcome } from './welcome.js';

const listeners = vi.hoisted(() => [] as Array<{ processor: (message: IncomingMessage) => Promise<unknown>; onContext: (peer: string, token: string) => void }>);
vi.mock('./identity.js', async original => ({ ...await original<typeof import('./identity.js')>(), lockWeChatIdentity: () => Promise.resolve(() => Promise.resolve()) }));
vi.mock('./message-listener.js', () => ({ WeChatMessageListener: class {
  constructor(_client: unknown, processor: (message: IncomingMessage) => Promise<unknown>, options: { onContext: (peer: string, token: string) => void }) {
    listeners.push({ processor, onContext: options.onContext });
  }
  start() {} async stop() {} isListening() { return true; } isHealthy() { return true; }
} }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); listeners.splice(0);
  for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); }
});
async function fixture() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (!url.endsWith('/ilink/bot/getconfig') && !url.endsWith('/ilink/bot/sendtyping')) { throw new Error('Unexpected live request'); }
    return Promise.resolve(new Response('{"ret":0}'));
  }));
  const root = await mkdtemp(join(tmpdir(), 'disclaude-welcome-channel-')); roots.push(root);
  const store = new WeChatStateStore(root);
  await store.saveCredentials({ botId: 'bot-fixture', token: 'offline-fixture', baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
  const tasks = vi.fn().mockResolvedValue(undefined);
  const create = async () => {
    const channel = new WeChatChannel({ stateDir: root }); channel.onMessage(tasks); await channel.start();
    return { channel, listener: listeners.at(-1)! };
  };
  return { root, store, tasks, create };
}
const message = (id: string): IncomingMessage => ({ messageId: id, chatId: 'peer@im.wechat', userId: 'peer@im.wechat',
  content: '请处理首条真实任务', messageType: 'text', timestamp: Date.now() });
const welcomeOf = (channel: WeChatChannel) => (channel as unknown as { welcome?: WeChatWelcome }).welcome;

describe('actual WeChat welcome wiring (#5469)', () => {
  it('keeps both typing and welcome ownership through channel shutdown', async () => {
    const f = await fixture(); let finishWelcome!: (id: string) => void, finishTyping!: (sent: boolean) => void;
    let welcomeStarted!: () => void, typingStarted!: () => void;
    const welcomeEntered = new Promise<void>(resolve => { welcomeStarted = resolve; });
    const typingEntered = new Promise<void>(resolve => { typingStarted = resolve; });
    vi.spyOn(WeChatApiClient.prototype, 'sendText').mockImplementation(() => {
      welcomeStarted(); return new Promise<string>(resolve => { finishWelcome = resolve; });
    });
    const typing = vi.spyOn(WeChatApiClient.prototype, 'sendTyping').mockImplementationOnce(() => {
      typingStarted(); return new Promise<boolean>(resolve => { finishTyping = resolve; });
    }).mockResolvedValue(true);
    const current = await f.create(); let stopped = false;
    try {
      current.listener.onContext('peer@im.wechat', 'private-context');
      const release = current.channel.beginTyping('peer@im.wechat');
      await Promise.all([welcomeEntered, typingEntered]);
      const stopping = current.channel.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      finishWelcome('welcome-ack'); await welcomeOf(current.channel)!.idle();
      expect(stopped).toBe(false);
      finishTyping(true); await stopping; release();
      expect(typing.mock.calls.map(([request]) => request.status)).toEqual([1, 2]);
      expect(welcomeOf(current.channel)).toBeUndefined();
      expect((current.channel as unknown as { typing?: unknown }).typing).toBeUndefined();
    } finally { finishWelcome?.('cleanup'); finishTyping?.(true); await current.channel.stop(); }
  });
  it('starts after legal context, never waits to forward the first task, and stays deduplicated after restart', async () => {
    const f = await fixture(); let finish!: (id: string) => void; let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const send = vi.spyOn(WeChatApiClient.prototype, 'sendText').mockImplementation(() => { started(); return new Promise<string>(resolve => { finish = resolve; }); });
    let current = await f.create();
    try {
      expect(send).not.toHaveBeenCalled();
      await current.listener.processor(message('without-context'));
      expect(send).not.toHaveBeenCalled(); expect(f.tasks).toHaveBeenCalledTimes(1);
      current.listener.onContext('peer@im.wechat', 'private-context');
      await current.listener.processor(message('first-valid')); await sending;
      expect(f.tasks).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith({ to: 'peer@im.wechat', content: WECHAT_WELCOME_TEXT, contextToken: 'private-context' });
      expect((await f.store.loadWelcome('bot-fixture')).peers['peer@im.wechat'].phase).toBe('attempted');
      current.listener.onContext('peer@im.wechat', 'new-context'); await current.listener.processor(message('another'));
      finish('welcome-ack'); await welcomeOf(current.channel)!.idle(); await current.channel.stop();
      current = await f.create(); current.listener.onContext('peer@im.wechat', 'after-restart');
      await current.listener.processor(message('after-restart')); await welcomeOf(current.channel)!.idle();
      expect(send).toHaveBeenCalledTimes(1); expect(f.tasks).toHaveBeenCalledTimes(4);
      expect((await f.store.loadWelcome('bot-fixture')).peers['peer@im.wechat']).toMatchObject({ phase: 'accepted', messageId: 'welcome-ack' });
    } finally { finish?.('cleanup-ack'); await current.channel.stop(); }
  });
  it('keeps task reception working when welcome delivery fails or private welcome state is corrupt', async () => {
    const f = await fixture(); const send = vi.spyOn(WeChatApiClient.prototype, 'sendText').mockRejectedValue(new Error('private-fixture-network-error'));
    let current = await f.create();
    try {
      current.listener.onContext('peer@im.wechat', 'private-context'); await current.listener.processor(message('first')); await welcomeOf(current.channel)!.idle();
      expect(f.tasks).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
      current.listener.onContext('peer@im.wechat', 'next-context'); await current.listener.processor(message('second')); await welcomeOf(current.channel)!.idle();
      expect(send).toHaveBeenCalledTimes(1); await current.channel.stop();
      const file = join(f.root, 'welcome.json'); await writeFile(file, 'private-corrupt');
      current = await f.create(); current.listener.onContext('peer@im.wechat', 'last-context'); await current.listener.processor(message('third'));
      expect(f.tasks).toHaveBeenCalledTimes(3); expect(send).toHaveBeenCalledTimes(1);
      expect(await readFile(file, 'utf8')).toBe('private-corrupt');
    } finally { await current.channel.stop(); }
  });
});
