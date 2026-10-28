/** Real registry, lifecycle and REST; Tencent long polls are intercepted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nock from 'nock';
import { WeChatRegistry } from '../../packages/service/src/channels/wechat/registry.js';
import { WeChatRegistrationRuntime } from '../../packages/service/src/channels/wechat/runtime.js';
import { DisclaudeService } from '../../packages/service/src/service.js';
import { ChannelLifecycleManager } from '../../packages/service/src/channel-lifecycle-manager.js';
import { WECHAT_WIRED_DESCRIPTOR, REST_WIRED_DESCRIPTOR } from '../../packages/service/src/channels/wired-descriptors.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => { nock.cleanAll(); vi.restoreAllMocks(); });
// Long polls stay pending until abort; the startup session probe (#5479) is
// what confirms health, so getconfig must answer like a healthy account.
function answerSessionProbes() {
  nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getupdates').reply((_uri, _body, _callback) => {});
  nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getconfig').reply(200, { ret: 0 });
}
function setup(dir: string) {
  const service = new DisclaudeService();
  const manager = service.getChannelManager();
  const context = { logger, service, controlHandler: vi.fn(), controlHandlerContext: {},
    agentPool: { getPoolStats: vi.fn(() => ({})), getOrCreateChatAgent: vi.fn() },
    inputMessageRouter: { route: vi.fn() },
  };
  const lifecycle = new ChannelLifecycleManager(manager, context as never);
  lifecycle.registerWiredDescriptor(WECHAT_WIRED_DESCRIPTOR);
  const registry = new WeChatRegistry(dir);
  return { service, manager, lifecycle, registry, runtime: new WeChatRegistrationRuntime(registry, lifecycle, service, { intervalMs: 10 }) };
}

describe('WeChat registration runtime', () => {
  it('hot-adds accounts from zero, isolates failed accounts, and applies enable/remove without stopping REST', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-hot-registration-'));
    const { manager, lifecycle, registry, runtime } = setup(dir);
    answerSessionProbes();
    let stopped = false;
    try {
      await lifecycle.createAndWire(REST_WIRED_DESCRIPTOR, { port: 0, host: '127.0.0.1', fileStorageDir: join(dir, 'rest') });
      await lifecycle.startAll();
      await runtime.start();
      expect(manager.getAll().map(channel => channel.id)).toEqual(['rest']);
      const register = (suffix: string) => registry.register({ botId: `${dir}-${suffix}`, token: 'test-token',
        baseUrl: 'https://ilinkai.weixin.qq.com', userId: `fixture-user-${suffix}`, savedAt: new Date().toISOString() });
      const first = await register('first');
      await vi.waitFor(() => expect(manager.get(registry.channelId(first))?.isHealthy()).toBe(true));
      const firstInstance = manager.get(registry.channelId(first));
      const second = await register('second');
      await vi.waitFor(() => expect(manager.get(registry.channelId(second))?.isHealthy()).toBe(true));
      expect(manager.get(registry.channelId(first))).toBe(firstInstance);
      const failed = await register('failed');
      await registry.setEnabled(failed.id, false);
      await vi.waitFor(() => expect(manager.get(registry.channelId(failed))).toBeUndefined());
      await unlink(join(registry.stateDir(failed), 'auth.json'));
      await registry.setEnabled(failed.id, true);
      await vi.waitFor(() => expect(manager.get(registry.channelId(failed))?.status).toBe('error'));
      expect(firstInstance?.isHealthy()).toBe(true);
      expect(manager.get('rest')?.isHealthy()).toBe(true);
      await registry.setEnabled(first.id, false);
      await vi.waitFor(() => expect(manager.get(registry.channelId(first))).toBeUndefined());
      await registry.setEnabled(first.id, true);
      await vi.waitFor(() => expect(manager.get(registry.channelId(first))?.isHealthy()).toBe(true));
      await registry.remove(second.id);
      await vi.waitFor(() => expect(manager.get(registry.channelId(second))).toBeUndefined());
      expect(manager.get('rest')?.isHealthy()).toBe(true);
      await runtime.stop(); stopped = true;
      expect(manager.getAll().map(channel => channel.id)).toEqual(['rest']);
      const restored = setup(dir);
      try {
        await restored.runtime.start();
        await vi.waitFor(() => expect(restored.manager.get(registry.channelId(first))?.isHealthy()).toBe(true));
        expect(restored.manager.get(registry.channelId(second))).toBeUndefined();
        expect(restored.manager.get(registry.channelId(failed))?.status).toBe('error');
      } finally { await restored.runtime.stop(); }
    } finally { if (!stopped) { await runtime.stop(); } await lifecycle.stopAll(); await rm(dir, { recursive: true, force: true }); }
  });

  it('retains working accounts on a corrupt update and isolates a corrupt registry on startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registry-corruption-'));
    const { manager, registry, runtime } = setup(dir);
    answerSessionProbes();
    try {
      const account = await registry.register({ botId: dir, token: 'test-token', userId: 'fixture-user-corrupt', baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
      await runtime.start();
      await writeFile(join(dir, 'accounts.json'), 'corrupted-private-registry');
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(manager.get(registry.channelId(account))?.isHealthy()).toBe(true);
      const other = setup(dir);
      await expect(other.runtime.start()).resolves.toBeUndefined();
      expect(other.runtime.getHealth()).toEqual({ status: 'degraded', reason: 'registry_unavailable' });
      await other.runtime.stop();
    } finally { await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps REST available with an empty registry lock and resumes after its explicit repair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wechat-registry-empty-lock-'));
    const { manager, lifecycle, runtime } = setup(dir);
    try {
      await lifecycle.createAndWire(REST_WIRED_DESCRIPTOR, { port: 0, host: '127.0.0.1', fileStorageDir: join(dir, 'rest') });
      const guard = join(dir, '.registry-lock');
      await mkdir(guard, { recursive: true });
      await writeFile(join(guard, 'listener.lock'), '');
      // Same ordering as cli-main: registration precedes ordinary channel startup.
      await runtime.start();
      await lifecycle.startAll();
      expect(manager.get('rest')?.isHealthy()).toBe(true);
      expect(runtime.getHealth().status).toBe('degraded');
      expect(await readFile(join(guard, 'listener.lock'), 'utf8')).toBe('');
      // Simulate an operator repairing only this known test-owned empty lock.
      await unlink(join(guard, 'listener.lock'));
      await vi.waitFor(() => expect(runtime.getHealth().status).toBe('healthy'));
      expect(manager.get('rest')?.isHealthy()).toBe(true);
    } finally { await runtime.stop(); await lifecycle.stopAll(); await rm(dir, { recursive: true, force: true }); }
  });
});
