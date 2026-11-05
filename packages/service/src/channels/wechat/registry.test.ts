import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WeChatIdentityMismatchError, WeChatRegistry } from './registry.js';
import { WeChatStateStore } from './state-store.js';

const credentials = (botId = 'bot-a', userId?: string) => ({ botId, token: `private-${botId}`, baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString(), ...(userId ? { userId } : {}) });
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wechat-registry-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('dynamic WeChat registry', () => {
  it('starts empty, registers completed logins concurrently, and restores private stable identities', async () => {
    const registry = new WeChatRegistry(dir);
    expect(await registry.list()).toEqual([]);
    const accounts = await Promise.all(['bot-a', 'bot-b'].map(bot => registry.register(credentials(bot))));
    expect(new Set(accounts.map(account => account.id)).size).toBe(2);
    const restored = new WeChatRegistry(dir);
    expect((await restored.list()).map(account => account.id).sort()).toEqual(accounts.map(account => account.id).sort());
    for (const account of accounts) {
      expect(registry.channelId(account)).toBe(`wechat:${account.id}`);
      expect((await new WeChatStateStore(registry.stateDir(account)).loadCredentials())?.botId).toBe(account.botId);
      expect((await stat(registry.stateDir(account))).mode & 0o777).toBe(0o700);
    }
    expect((await stat(join(dir, 'accounts.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'accounts.json'), 'utf8')).not.toContain('private-');
  });

  it('imports singleton credentials once without resetting peer contexts or duplicating identity', async () => {
    const old = new WeChatStateStore(dir);
    await old.saveCredentials(credentials());
    await old.saveSession({ botId: 'bot-a', cursor: 'saved', seenMessageIds: ['accepted'], contexts: { 'peer@im.wechat': 'private-context' } });
    const registry = new WeChatRegistry(dir);
    const [account] = await registry.list();
    expect(account.legacy).toBe(true);
    expect(registry.stateDir(account)).toBe(dir);
    expect(registry.channelId(account)).toBe('wechat');
    expect(await registry.list()).toEqual([account]);
    expect((await old.loadSession('bot-a')).cursor).toBe('saved');
    await registry.remove(account.id);
    expect(await new WeChatRegistry(dir).list()).toEqual([]);
    expect(await old.loadCredentials()).toBeDefined();
  });

  it('reauthenticates the same identity in place and preserves disabled/removal decisions across restart', async () => {
    const registry = new WeChatRegistry(dir);
    const first = await registry.register(credentials());
    await registry.setEnabled(first.id, false);
    expect((await new WeChatRegistry(dir).list())[0].enabled).toBe(false);
    const next = await registry.register({ ...credentials(), token: 'replacement' }, first.id);
    expect(next.id).toBe(first.id);
    expect(next.generation).not.toBe(first.generation);
    expect(next.enabled).toBe(true);
    // #5480 (maintainer review on #5662): without the WeChat-server-provided
    // user id the rebind cannot be verified, so a scanned new bot identity
    // stays a typed refusal carrying both identities, never an overwrite.
    const mismatch = await registry.register(credentials('another-bot'), first.id).catch(error => error);
    expect(mismatch).toBeInstanceOf(WeChatIdentityMismatchError);
    expect(mismatch).toMatchObject({ targetId: first.id, registeredBotId: 'bot-a', scannedBotId: 'another-bot' });
    expect(await registry.list()).toHaveLength(1);
    await registry.remove(first.id);
    expect(await new WeChatRegistry(dir).list()).toEqual([]);
  });

  it('rebinds a returning WeChat user by the server-provided id and refuses a different user (#5480 review)', async () => {
    const registry = new WeChatRegistry(dir);
    const first = await registry.register(credentials('bot-a', 'user@im.wechat'));
    // A fresh scan from the same WeChat user with a new bot identity rebinds
    // the registration in place — whether the scanned user already exists is
    // judged by the WeChat-server-provided user id, not a command-line id.
    const rebound = await registry.register(credentials('bot-new', 'user@im.wechat'), first.id);
    expect(rebound).toMatchObject({ id: first.id, botId: 'bot-new', enabled: true });
    expect((await new WeChatStateStore(registry.stateDir(rebound)).loadCredentials())?.botId).toBe('bot-new');
    // A plain scan from the same user lands on the same registration instead
    // of registering a parallel account.
    expect((await registry.register(credentials('bot-next', 'user@im.wechat'))).id).toBe(first.id);
    expect(await registry.list()).toHaveLength(1);
    // A different WeChat user is refused on the explicit target and — without
    // one — registers separately rather than touching the existing account.
    const stranger = await registry.register(credentials('intruder', 'someone-else@im.wechat'), first.id).catch(error => error);
    expect(stranger).toBeInstanceOf(WeChatIdentityMismatchError);
    const separate = await registry.register(credentials('intruder', 'someone-else@im.wechat'));
    expect(separate.id).not.toBe(first.id);
    expect(await registry.list()).toHaveLength(2);
  });

  it('rejects duplicate registration while a listener owns the account, without changing credentials', async () => {
    const registry = new WeChatRegistry(dir);
    const first = await registry.register(credentials());
    const store = new WeChatStateStore(registry.stateDir(first));
    const release = await store.lock();
    try {
      await expect(registry.register({ ...credentials(), token: 'must-not-overwrite' })).rejects.toThrow('disable');
      expect(await registry.list()).toEqual([first]);
      expect((await store.loadCredentials())?.token).toBe('private-bot-a');
    } finally { await release(); }
  });

  it('does not overwrite an account management change made during QR reauthentication', async () => {
    const registry = new WeChatRegistry(dir);
    const account = await registry.register(credentials());
    const suspended = await registry.setEnabled(account.id, false);
    await registry.setEnabled(account.id, false);
    await expect(registry.register({ ...credentials(), token: 'must-not-overwrite' }, account.id, suspended.generation))
      .rejects.toThrow('changed during login');
    expect((await registry.list())[0].enabled).toBe(false);
    expect((await new WeChatStateStore(registry.stateDir(account)).loadCredentials())?.token).toBe('private-bot-a');
  });

  it('rejects incomplete logins, corrupt registries, duplicate entries and symlink files', async () => {
    const registry = new WeChatRegistry(dir);
    await expect(registry.register({ ...credentials(), token: '' })).rejects.toThrow('Incomplete');
    expect(await registry.list()).toEqual([]);
    const account = await registry.register(credentials());
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account, account] }));
    await expect(registry.list()).rejects.toThrow('Invalid WeChat registry');
    await writeFile(join(dir, 'accounts.json'), 'private malformed registry');
    await expect(registry.list()).rejects.toThrow('Invalid WeChat registry');
    await rm(join(dir, 'accounts.json'));
    await writeFile(join(dir, 'outside'), '{"version":1,"accounts":[]}');
    await symlink(join(dir, 'outside'), join(dir, 'accounts.json'));
    await expect(registry.list()).rejects.toThrow('Cannot read WeChat registry');
  });
});
