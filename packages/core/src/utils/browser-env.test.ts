import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserAgentEnv } from './browser-env.js';
import { buildSdkEnv } from './sdk.js';
afterEach(() => vi.unstubAllEnvs());
describe('coordinated browser environment', () => {
  it('removes both inherited and configured discovery after merging without mutating the service environment', () => {
    vi.stubEnv('BU_CDP_URL', 'http://inherited.invalid:9223');
    const env = browserAgentEnv(buildSdkEnv('test', undefined, {
      DISCLAUDE_BROWSER_SOCKET: '/tmp/browser.sock',
      BU_CDP_WS: 'ws://configured.invalid',
      CHROMIUM_CDP_PORT: '9223',
      DISCLAUDE_CHROMIUM_BINARY: '/private/chromium',
      BH_RUNTIME_DIR: '/private/worker',
      NORMAL_SETTING: 'preserved',
    }));
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBe('/tmp/browser.sock');
    for (const key of [
      'BU_CDP_URL',
      'BU_CDP_WS',
      'CHROMIUM_CDP_PORT',
      'DISCLAUDE_CHROMIUM_BINARY',
      'BH_RUNTIME_DIR',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.NORMAL_SETTING).toBe('preserved');
    expect(process.env.BU_CDP_URL).toBe('http://inherited.invalid:9223');
    expect(browserAgentEnv({ ...env, BU_CDP_URL: 'http://late-merge.invalid' })).not.toHaveProperty(
      'BU_CDP_URL'
    );
  });
  it.each([
    { BU_CDP_URL: 'http://stale.invalid', DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: '' },
    { DISCLAUDE_BROWSER_BIN: '/owned/bin', BU_CDP_WS: 'ws://stale.invalid' },
  ])('fails closed if a coordinated task loses its socket', env => {
    expect(() => browserAgentEnv(env)).toThrow('missing its IPC socket');
  });
  it('preserves legacy service configuration outside coordinated mode', () => {
    const env = { BU_CDP_WS: 'ws://worker-private', PATH: '/bin' };
    expect(browserAgentEnv(env)).toBe(env);
  });
});

it('selects the managed IPC launcher after a task overrides PATH', () => {
  const env = browserAgentEnv({ DISCLAUDE_BROWSER_SOCKET: '/tmp/browser.sock',
    DISCLAUDE_BROWSER_BIN: '/owned/bin', PATH: '/upstream/bin:/owned/bin:/usr/bin',
    DISCLAUDE_BROWSER_MODE: 'coordinated', BU_CDP_URL: 'http://stale.invalid' });
  expect(env.PATH).toBe('/owned/bin:/upstream/bin:/usr/bin');
  expect(env).not.toHaveProperty('BU_CDP_URL');
  expect(env).not.toHaveProperty('DISCLAUDE_BROWSER_MODE');
});
