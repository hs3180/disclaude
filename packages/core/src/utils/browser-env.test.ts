import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserAgentEnv } from './browser-env.js';
import { buildSdkEnv } from './sdk.js';
afterEach(() => vi.unstubAllEnvs());
describe('coordinated browser environment', () => {
  it('removes both inherited and configured discovery after merging without mutating the service environment', () => {
    vi.stubEnv('BU_CDP_URL', 'http://inherited.invalid:9223');
    const env = buildSdkEnv('test', undefined, {
      DISCLAUDE_BROWSER_SOCKET: '/tmp/browser.sock',
      BU_CDP_WS: 'ws://configured.invalid',
      CHROMIUM_CDP_PORT: '9223',
      DISCLAUDE_CHROMIUM_BINARY: '/private/chromium',
      BH_RUNTIME_DIR: '/private/worker',
      NORMAL_SETTING: 'preserved',
    });
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
  it('preserves legacy service configuration outside coordinated mode', () => {
    const env = { BU_CDP_WS: 'ws://worker-private', PATH: '/bin' };
    expect(browserAgentEnv(env)).toBe(env);
  });
});
