import { describe, it, expect, vi, afterEach } from 'vitest';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { browserAgentEnv, resolveBrowserSocketPath } from './browser-env.js';
import { buildSdkEnv } from './sdk.js';
afterEach(() => vi.unstubAllEnvs());
describe('coordinated browser environment', () => {
  it('removes direct browser discovery and ignores a user-supplied socket', () => {
    vi.stubEnv('BU_CDP_URL', 'http://inherited.invalid:9223');
    const source = buildSdkEnv('test', undefined, {
      DISCLAUDE_CONFIG_PATH: '/tmp/disclaude-browser-env-test.yaml',
      DISCLAUDE_BROWSER_SOCKET: '/tmp/user-configured.sock',
      BU_CDP_WS: 'ws://configured.invalid',
      CHROMIUM_CDP_PORT: '9223',
      DISCLAUDE_CHROMIUM_BINARY: '/private/chromium',
      BH_RUNTIME_DIR: '/private/worker',
      NORMAL_SETTING: 'preserved',
    });
    const env = browserAgentEnv(source);
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBe(resolveBrowserSocketPath(source));
    expect(env.DISCLAUDE_BROWSER_SOCKET).not.toBe('/tmp/user-configured.sock');
    expect(env.DISCLAUDE_CONFIG_PATH).toBe(resolve(source.DISCLAUDE_CONFIG_PATH!));
    for (const key of [
      'BU_CDP_URL',
      'BU_CDP_WS',
      'CHROMIUM_CDP_PORT',
      'DISCLAUDE_CHROMIUM_BINARY',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.NORMAL_SETTING).toBe('preserved');
    expect(env.BH_RUNTIME_DIR).toBe(devNull);
    expect(env.BH_TMP_DIR).toBe(devNull);
    expect(env.BH_REQUIRE_EXISTING_DAEMON).toBe('1');
    expect(process.env.BU_CDP_URL).toBe('http://inherited.invalid:9223');
    expect(browserAgentEnv({ ...env, BU_CDP_URL: 'http://late-merge.invalid' })).not.toHaveProperty(
      'BU_CDP_URL'
    );
  });
  it('derives a private absolute IPC path even without a socket setting', () => {
    const env = browserAgentEnv({ DISCLAUDE_CONFIG_PATH: '/tmp/disclaude-browser-env-relative.yaml' });
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBe(resolveBrowserSocketPath({
      DISCLAUDE_CONFIG_PATH: '/tmp/disclaude-browser-env-relative.yaml',
    }));
    expect(env.DISCLAUDE_BROWSER_SOCKET?.startsWith('/')).toBe(true);
  });
  it('injects the internal path and blocks direct browser discovery without user socket config', () => {
    const source = { BU_CDP_WS: 'ws://worker-private', PATH: '/bin' };
    const env = browserAgentEnv(source);
    expect(env).not.toBe(source);
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBe(resolveBrowserSocketPath(source));
    expect(env).not.toHaveProperty('BU_CDP_WS');
    expect(env.BH_RUNTIME_DIR).toBe(devNull);
  });
  it('keeps the service-pinned endpoint when provider env overrides runtime directories', () => {
    vi.stubEnv('DISCLAUDE_BROWSER_SOCKET', '/tmp/service-owned-browser.sock');
    const env = browserAgentEnv({
      DISCLAUDE_CONFIG_PATH: '/agent/config.yaml',
      DISCLAUDE_BROWSER_SOCKET: '/tmp/user-configured.sock',
      HOME: '/agent-home',
      XDG_RUNTIME_DIR: '/agent-runtime',
      PATH: '/usr/bin',
    });
    expect(env.DISCLAUDE_BROWSER_SOCKET).toBe('/tmp/service-owned-browser.sock');
  });
});

it('prepends the automatically resolved launcher after a task overrides PATH', () => {
  const source = {
    DISCLAUDE_CONFIG_PATH: './disclaude-browser-path-test.yaml',
    DISCLAUDE_BROWSER_SOCKET: '/tmp/user-configured.sock',
    DISCLAUDE_BROWSER_BIN: '/owned/bin',
    PATH: '/upstream/bin:/tmp/bin:/usr/bin',
    BU_CDP_URL: 'http://stale.invalid',
  };
  const env = browserAgentEnv(source);
  expect(env.PATH).toBe(`${join(dirname(resolveBrowserSocketPath(source)), 'bin')}:/upstream/bin:/usr/bin`);
  expect(env.DISCLAUDE_CONFIG_PATH).toBe(resolve(source.DISCLAUDE_CONFIG_PATH!));
  expect(resolveBrowserSocketPath(env)).toBe(resolveBrowserSocketPath(source));
  expect(env.DISCLAUDE_BROWSER_SOCKET).toBe(resolveBrowserSocketPath(source));
  expect(env).not.toHaveProperty('BU_CDP_URL');
});
