import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveChannelConfigs } from '../../cli-main.js';
import { DEFAULT_WECHAT_STATE_DIR } from './state-store.js';

afterEach(() => vi.unstubAllEnvs());

describe('single WeChat channel configuration', () => {
  it('resolves Feishu, REST and one WeChat channel from the same config', () => {
    vi.stubEnv('WECHAT_TEST_FEISHU_SECRET', 'mock-feishu-secret');
    const entries = resolveChannelConfigs({ channels: {
      feishu: { appId: 'public-app', appSecret: '$WECHAT_TEST_FEISHU_SECRET' },
      rest: { port: 5000, host: '127.0.0.1', fileStorageDir: '/private/files' },
      wechat: { stateDir: '/private/wechat', routeTag: 'wechat-route' },
    } }, { FEISHU_APP_ID: 'public-app', FEISHU_APP_SECRET: 'mock-feishu-secret', FEISHU_STREAMING_CARD: false } as never);
    expect(entries.map(x => x.type)).toEqual(['rest', 'feishu', 'wechat']);
    expect(entries.at(-1)?.config).toEqual({ stateDir: '/private/wechat', routeTag: 'wechat-route' });
    expect(resolveChannelConfigs({ channels: { wechat: { enabled: true } } }, {} as never))
      .toEqual([{ type: 'wechat', config: { stateDir: DEFAULT_WECHAT_STATE_DIR } }]);
  });

  it('keeps disabled channels from loading secrets or account state', () => {
    expect(resolveChannelConfigs({ channels: {
      feishu: { enabled: false, appSecret: '$MISSING_DISABLED_SECRET' },
      wechat: { stateDir: '/private/wechat' },
    } }, {} as never).map(x => x.type)).toEqual(['wechat']);
    expect(resolveChannelConfigs({ channels: { wechat: { enabled: false, stateDir: 'unused' } } }, {} as never)).toEqual([]);
  });

  it.each([
    [{ accounts: { work: {} } }, 'Unsupported'],
    [{ token: 'private' }, 'Unsupported'],
    [{ enabled: 'true' }, 'boolean'],
    [{ stateDir: 'relative' }, 'absolute'],
    [{ routeTag: 'first\nsecond' }, 'single-line'],
  ])('rejects unsupported or invalid WeChat configuration %j', (wechat, diagnostic) => {
    expect(() => resolveChannelConfigs({ channels: { wechat: wechat as never } }, {} as never)).toThrow(diagnostic);
  });
});
