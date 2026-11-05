/**
 * Dynamic multi-account isolation and restart recovery (#5451 phase 1).
 *
 * Locks the phase-1 acceptance surface of WeChat dynamic multi-account
 * registration at message level through the real registration runtime:
 * per-account instance identity, per-account state isolation on disk
 * (credentials/cursor/dedup/reply context/welcome), shared-root peer
 * identity bindings, cross-account outbound routing through the service,
 * and restart recovery without message replay or welcome re-send.
 *
 * Real registry, runtime wiring and service handler dispatch; Tencent
 * long polls are intercepted per account host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nock from 'nock';
import { WeChatRegistry, type WeChatRegistration } from '../../packages/service/src/channels/wechat/registry.js';
import { WeChatRegistrationRuntime } from '../../packages/service/src/channels/wechat/runtime.js';
import { DisclaudeService } from '../../packages/service/src/service.js';
import { ChannelLifecycleManager } from '../../packages/service/src/channel-lifecycle-manager.js';
import { WECHAT_WIRED_DESCRIPTOR } from '../../packages/service/src/channels/wired-descriptors.js';
import { getWeChatWelcomeText } from '../../packages/service/src/channels/wechat/welcome.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** Same peer and same raw message id on every account: isolation must namespace both. */
const peer = 'same-peer@im.wechat';
const messageId = 'same-message';

interface AccountFixture {
  suffix: string;
  host: string;
  /** Raw iLink payloads are re-served on odd polls so restart replay suppression is exercised. */
  polls: number;
  welcomes: number;
  /** Delivering polls still owed after a restart; budget 2 survives one poll aborted mid-stop. */
  restartBudget?: number;
  /** True once a delivering poll actually fired after the restart flag was set. */
  deliveredAfterRestart?: boolean;
  account?: WeChatRegistration;
}

afterEach(() => { nock.cleanAll(); vi.restoreAllMocks(); });

function interceptAccount(fixture: AccountFixture): void {
  nock(fixture.host).persist().post('/ilink/bot/getupdates').reply((_uri, _body, callback) => {
    fixture.polls++;
    const budgeted = (fixture.restartBudget ?? 0) > 0;
    if (budgeted) { fixture.restartBudget!--; fixture.deliveredAfterRestart = true; }
    if (fixture.polls % 2 === 1 || budgeted) {
      callback(null, [200, { ret: 0, get_updates_buf: `cursor-${fixture.suffix}`, msgs: [{ message_id: messageId,
        from_user_id: peer, message_type: 1, context_token: `ctx-${fixture.suffix}`,
        item_list: [{ type: 1, text_item: { text: `text-${fixture.suffix}` } }] }] }]);
    }
    // An outstanding long poll has no delayed reply to race its abort.
  });
  // Startup session probe (#5479) must confirm the saved login.
  nock(fixture.host).persist().post('/ilink/bot/getconfig').reply(200, { ret: 0, typing_ticket: 'ticket' });
  nock(fixture.host).persist().post('/ilink/bot/sendtyping').reply(200, { ret: 0 });
  nock(fixture.host).persist().post('/ilink/bot/sendmessage', body =>
    body.msg.to_user_id === peer && body.msg.context_token === `ctx-${fixture.suffix}`
      && body.msg.item_list[0].text_item.text === getWeChatWelcomeText())
    .reply(() => { fixture.welcomes++; return [200, { ret: 0, message_id: `welcome-${fixture.suffix}` }]; });
  // Reply routing: persist so pre- and post-restart sends both match; the
  // per-account context_token filter makes any cross-account misroute fail loudly.
  nock(fixture.host).persist().post('/ilink/bot/sendmessage', body =>
    body.msg.to_user_id === peer && body.msg.context_token === `ctx-${fixture.suffix}`
      && body.msg.item_list[0].text_item.text === `reply-${fixture.suffix}`)
    .reply(200, { ret: 0, message_id: `sent-${fixture.suffix}` });
}

/** One service-process simulation: fresh wiring over the same private registry root. */
function setup(dir: string, routed: { chatId: string; messageId: string }[]) {
  const service = new DisclaudeService();
  const manager = service.getChannelManager();
  const context = { logger, service, controlHandler: vi.fn(), controlHandlerContext: {},
    agentPool: { getPoolStats: vi.fn(() => ({})), getOrCreateChatAgent: vi.fn() },
    inputMessageRouter: { route: vi.fn(async (message: { chatId: string; messageId?: string }) => {
      routed.push({ chatId: message.chatId, messageId: message.messageId ?? '' });
    }) },
  };
  const lifecycle = new ChannelLifecycleManager(manager, context as never);
  lifecycle.registerWiredDescriptor(WECHAT_WIRED_DESCRIPTOR);
  return { service, manager, lifecycle, registry: new WeChatRegistry(dir),
    runtime: new WeChatRegistrationRuntime(new WeChatRegistry(dir), lifecycle, service, { intervalMs: 10 }) };
}

describe('dynamic multi-account isolation and restart recovery (#5451)', () => {
  it('isolates two dynamically registered accounts per instance identity and state, and restores both after restart without replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-dynamic-accounts-'));
    const fixtures: AccountFixture[] = [
      { suffix: 'a', host: 'https://a.weixin.qq.com', polls: 0, welcomes: 0 },
      { suffix: 'b', host: 'https://b.weixin.qq.com', polls: 0, welcomes: 0 },
    ];
    for (const fixture of fixtures) { interceptAccount(fixture); }
    const routed: { chatId: string; messageId: string }[] = [];
    const first = setup(dir, routed);
    let stopped = false;
    try {
      for (const fixture of fixtures) {
        fixture.account = await first.registry.register({ botId: `${dir}-${fixture.suffix}`, token: `token-${fixture.suffix}`,
          userId: `fixture-user-${fixture.suffix}`, baseUrl: fixture.host, savedAt: new Date().toISOString() });
      }
      await first.runtime.start();
      for (const fixture of fixtures) {
        await vi.waitFor(() => expect(first.manager.get(first.registry.channelId(fixture.account!))?.isHealthy()).toBe(true));
      }

      // Inbound isolation: same peer and raw message id arrive once per account
      // under distinct qualified identities; private reply contexts never leak.
      await vi.waitFor(() => expect(routed).toHaveLength(2));
      expect(new Set(routed.map(message => message.chatId)).size).toBe(2);
      expect(new Set(routed.map(message => message.messageId)).size).toBe(2);
      for (const fixture of fixtures) {
        const chatId = `${first.registry.channelId(fixture.account!)}:${peer}`;
        expect(routed).toContainEqual({ chatId, messageId: `${first.registry.channelId(fixture.account!)}:${messageId}` });
      }
      expect(JSON.stringify(routed)).not.toContain('ctx-');
      expect(JSON.stringify(routed)).not.toContain('token-');

      // Outbound routing through the service: each qualified chatId reaches its
      // own account host with that account's private reply context.
      for (const fixture of fixtures) {
        await expect(first.service.sendMessage(`${first.registry.channelId(fixture.account!)}:${peer}`, `reply-${fixture.suffix}`))
          .resolves.toMatchObject({ messageId: `sent-${fixture.suffix}` });
      }
      await vi.waitFor(() => { for (const fixture of fixtures) { expect(fixture.welcomes).toBe(1); } });

      // Per-account state isolation at data-structure level: disjoint account
      // directories under one registry root, private files per account.
      const accountsRoot = join(dir, 'accounts');
      const rootEntries = new Set(await readdir(accountsRoot));
      for (const fixture of fixtures) {
        const accountDir = first.registry.stateDir(fixture.account!);
        expect(accountDir).toBe(join(accountsRoot, fixture.account!.id));
        expect(rootEntries.has(fixture.account!.id)).toBe(true);
        expect(((await stat(accountDir)).mode & 0o777)).toBe(0o700);
        const auth = JSON.parse(await readFile(join(accountDir, 'auth.json'), 'utf8')) as Record<string, unknown>;
        expect(((await stat(join(accountDir, 'auth.json'))).mode & 0o777)).toBe(0o600);
        expect(auth).toMatchObject({ token: `token-${fixture.suffix}`, botId: `${dir}-${fixture.suffix}`,
          userId: `fixture-user-${fixture.suffix}`, baseUrl: fixture.host });
        const session = JSON.parse(await readFile(join(accountDir, 'session.json'), 'utf8')) as Record<string, unknown>;
        expect(session).toMatchObject({ botId: `${dir}-${fixture.suffix}`, cursor: `cursor-${fixture.suffix}`,
          seenMessageIds: [messageId], contexts: { [peer]: `ctx-${fixture.suffix}` } });
      }
      // Cross-registration peer identity bindings live in the shared accounts
      // root (#5600), never inside one account's private directory.
      expect(rootEntries.has('peer-identities.json')).toBe(true);
      const bindings = JSON.parse(await readFile(join(accountsRoot, 'peer-identities.json'), 'utf8')) as { bindings: Record<string, unknown> };
      expect(Object.keys(bindings.bindings)).toHaveLength(2);

      // Restart recovery: a fresh process over the same registry root restores
      // both accounts, their reply contexts and dedup state — the re-served
      // message is not replayed and the welcome is not re-sent.
      await first.runtime.stop(); stopped = true;
      for (const fixture of fixtures) { fixture.restartBudget = 2; }
      const secondRouted: { chatId: string; messageId: string }[] = [];
      const second = setup(dir, secondRouted);
      try {
        await second.runtime.start();
        for (const fixture of fixtures) {
          await vi.waitFor(() => expect(second.manager.get(second.registry.channelId(fixture.account!))?.isHealthy()).toBe(true));
        }
        // Each account performed at least one delivering poll after restart
        // (budget 2 survives one poll aborted mid-stop).
        await vi.waitFor(() => {
          for (const fixture of fixtures) { expect(fixture.deliveredAfterRestart).toBe(true); }
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        // The restarted runtime re-delivers nothing: the persisted per-account
        // dedup tombstones suppress the replayed gateway message.
        expect(secondRouted).toHaveLength(0);
        expect(second.service.getChannels().map(channel => channel.id).sort())
          .toEqual(fixtures.map(fixture => second.registry.channelId(fixture.account!)).sort());
        // Restored reply contexts keep outbound routing working per account.
        for (const fixture of fixtures) {
          await expect(second.service.sendMessage(`${second.registry.channelId(fixture.account!)}:${peer}`, `reply-${fixture.suffix}`))
            .resolves.toMatchObject({ messageId: `sent-${fixture.suffix}` });
          const channel = second.manager.get(second.registry.channelId(fixture.account!))!;
          expect(channel.ownsChatId(`${second.registry.channelId(fixture.account!)}:${peer}`)).toBe(true);
        }
        const other = (fixture: AccountFixture) => fixtures.find(item => item !== fixture)!.account!;
        for (const fixture of fixtures) {
          const channel = second.manager.get(second.registry.channelId(fixture.account!))!;
          expect(channel.ownsChatId(`${second.registry.channelId(other(fixture))}:${peer}`)).toBe(false);
        }
        for (const fixture of fixtures) { expect(fixture.welcomes).toBe(1); }
      } finally { await second.runtime.stop(); }
    } finally {
      if (!stopped) { await first.runtime.stop(); }
      await first.lifecycle.stopAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
