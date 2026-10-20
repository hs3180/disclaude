import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWeChatAccounts } from './config.js';
import { wechatChatId, wechatPeer, wechatAccountStateDir } from './account.js';
import { resolveChannelConfigs } from '../../cli-main.js';
import { lockWeChatIdentity } from './state-store.js';

afterEach(() => vi.unstubAllEnvs());

describe('WeChat account configuration and identity', () => {
  it('keeps the old singleton and creates stable named account identities', () => {
    expect(resolveWeChatAccounts({ stateDir: '/private/legacy' })).toEqual([{ stateDir: '/private/legacy' }]);
    expect(resolveWeChatAccounts({ accounts: { work: {}, personal: { stateDir: '/private/personal' }, off: { enabled: false, token: 'unused' } } }))
      .toEqual([{ id: 'wechat:work', accountId: 'work', stateDir: wechatAccountStateDir('work') }, { id: 'wechat:personal', accountId: 'personal', stateDir: '/private/personal' }]);
    expect(resolveWeChatAccounts({ enabled: false, accounts: 'not-loaded' })).toEqual([]);
  });

  it('rejects ambiguous directories, mixed config, invalid names and embedded credentials', async () => {
    expect(() => resolveWeChatAccounts({ stateDir: '/a', accounts: { work: {} } })).toThrow('Unsupported');
    expect(() => resolveWeChatAccounts({ accounts: { '../escape': {} } })).toThrow('account name');
    expect(() => resolveWeChatAccounts({ accounts: { work: { enabled: 'true' } } })).toThrow('enabled');
    expect(() => resolveWeChatAccounts({ accounts: { work: { token: 'private' } } })).toThrow('Unsupported');
    expect(() => resolveWeChatAccounts({ accounts: { work: { stateDir: 'relative' } } })).toThrow('absolute');
    expect(() => resolveWeChatAccounts({ accounts: { work: { stateDir: '/a' }, home: { stateDir: '/b/../a' } } })).toThrow('duplicates');
    const dir = await mkdtemp(join(tmpdir(), 'wechat-config-'));
    try {
      await mkdir(join(dir, 'real')); await symlink(join(dir, 'real'), join(dir, 'alias'));
      expect(() => resolveWeChatAccounts({ accounts: { work: { stateDir: join(dir, 'real') }, home: { stateDir: join(dir, 'alias') } } })).toThrow('duplicates');
      expect(() => resolveWeChatAccounts({ accounts: { work: { stateDir: join(dir, 'real', 'future') }, home: { stateDir: join(dir, 'alias', 'future') } } })).toThrow('duplicates');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('resolves Feishu, REST and multiple WeChat accounts from the same config', () => {
    vi.stubEnv('WECHAT_TEST_FEISHU_SECRET', 'mock-feishu-secret');
    const entries = resolveChannelConfigs({ channels: {
      feishu: { appId: 'public-app', appSecret: '$WECHAT_TEST_FEISHU_SECRET' },
      rest: { port: 5000, host: '127.0.0.1', fileStorageDir: '/private/files' },
      wechat: { accounts: { work: { stateDir: '/private/work' }, home: { stateDir: '/private/home' } } },
    } }, { FEISHU_APP_ID: 'public-app', FEISHU_APP_SECRET: 'mock-feishu-secret', FEISHU_STREAMING_CARD: false } as never);
    expect(entries.map(x => [x.type, x.config.id ?? x.type])).toEqual([
      ['rest', 'rest'], ['feishu', 'feishu'], ['wechat', 'wechat:work'], ['wechat', 'wechat:home'],
    ]);
    expect(resolveChannelConfigs({ channels: { feishu: { enabled: false, appSecret: '$MISSING_DISABLED_SECRET' }, wechat: { stateDir: '/private/legacy' } } }, {} as never).map(x => x.type)).toEqual(['wechat']);
  });

  it('selects exactly one named account and excludes simultaneous listeners of one bot identity', async () => {
    const scoped = wechatChatId('work', 'user@im.wechat');
    expect(wechatPeer(scoped, 'work')).toBe('user@im.wechat');
    expect(() => wechatPeer(scoped, 'home')).toThrow('account-qualified');
    expect(() => wechatPeer('user@im.wechat', 'work')).toThrow('account-qualified');
    expect(() => wechatPeer(scoped)).toThrow('legacy');
    const bot = `followup-lock-${process.pid}`;
    const release = await lockWeChatIdentity(bot);
    try { await expect(lockWeChatIdentity(bot)).rejects.toThrow('already in use'); }
    finally { await release(); }
    const next = await lockWeChatIdentity(bot); await next();
  });
});
