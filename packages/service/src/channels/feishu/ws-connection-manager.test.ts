import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import { WsConnectionManager, calculateReconnectDelay } from './ws-connection-manager.js';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }));
vi.mock('@disclaude/core', () => ({
  createLogger: () => log,
  WS_HEALTH: { RECONNECT: { BASE_DELAY_MS: 100, MAX_DELAY_MS: 1000, BACKOFF_MULTIPLIER: 2, JITTER_MS: 0, MAX_ATTEMPTS: 3 } },
}));

type Lifecycle = { onReady: () => void; onReconnecting: () => void; onReconnected: () => void; onError: () => void };
type Client = Lifecycle & { start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const managers: WsConnectionManager[] = [];
function fixture(config: Partial<ConstructorParameters<typeof WsConnectionManager>[0]> = {}, startResult: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  const manager = new WsConnectionManager({ appId: 'cli_0000000000000000', appSecret: 'fixture', dnsCheckHost: '', ...config });
  managers.push(manager);
  const clients: Client[] = [];
  const construct = vi.fn(class {
    start = vi.fn(startResult);
    close = vi.fn();
    constructor(callbacks: Lifecycle) { Object.assign(this, callbacks); clients.push(this as unknown as Client); }
  });
  Object.assign(manager, { larkSDK: { WSClient: construct, LoggerLevel: lark.LoggerLevel } });
  const start = async () => { await manager.start(new lark.EventDispatcher({})); };
  return { manager, clients, construct, start };
}
function dnsProbe(manager: WsConnectionManager) {
  return vi.spyOn(manager as unknown as { checkDns: (host: string) => Promise<boolean> }, 'checkDns');
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(async () => {
  for (const manager of managers.splice(0)) { await manager.stop(); }
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('calculateReconnectDelay', () => {
  it('doubles each failed attempt and caps the complete delay including jitter', () => {
    expect([0, 1, 2].map(n => calculateReconnectDelay(n, 100, 1000, 0))).toEqual([100, 200, 400]);
    for (let n = 0; n < 100; n++) { expect(calculateReconnectDelay(n, 100, 1000, 500)).toBeLessThanOrEqual(1000); }
  });
  it('keeps jitter above the base delay', () => {
    for (let n = 0; n < 100; n++) { expect(calculateReconnectDelay(0, 100, 1000, 50)).toBeGreaterThanOrEqual(100); }
  });
});

describe('Feishu real readiness (#5519)', () => {
  it('does not interpret a resolved start() as a handshake receipt', async () => {
    const { manager, start, clients } = fixture();
    await start();
    expect(manager.getMetrics()).toEqual({ state: 'connecting', reconnectAttempt: 0, isConnected: false });
    expect(manager.isHealthy()).toBe(false);
    clients[0].onReady();
    expect(manager.isHealthy()).toBe(true);
    expect(manager.state).toBe('connected');
  });
  it('emits the queue-flush event on the first real handshake, once per transition', async () => {
    const { manager, start, clients } = fixture();
    const ready = vi.fn(); manager.on('reconnected', ready);
    await start(); expect(ready).not.toHaveBeenCalled();
    clients[0].onReady(); clients[0].onReady();
    expect(ready).toHaveBeenCalledExactlyOnceWith(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1); expect(clients[0].close).not.toHaveBeenCalled();
  });
  it('uses SDK live reconnect callbacks without constructing a second owner', async () => {
    const { manager, start, clients } = fixture();
    await start(); clients[0].onReady(); clients[0].onReconnecting();
    expect(manager.isHealthy()).toBe(false); expect(manager.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    clients[0].onReconnected(); expect(manager.isHealthy()).toBe(true);
  });
  it('replaces a terminal SDK failure after backoff and ignores duplicate/stale callbacks', async () => {
    const { manager, start, clients } = fixture();
    await start(); const [old] = clients; old.onReady(); old.onReconnecting(); old.onError(); old.onError();
    expect(old.close).toHaveBeenCalledExactlyOnceWith({ force: true });
    await vi.advanceTimersByTimeAsync(100); expect(clients).toHaveLength(2);
    old.onReady(); old.onReconnected(); old.onError();
    expect(manager.state).toBe('connecting'); expect(clients[1].close).not.toHaveBeenCalled();
    clients[1].onReady(); expect(manager.isHealthy()).toBe(true);
  });
  it('bounds initial configuration/handshake stalls while keeping start non-blocking', async () => {
    const { manager, start, clients } = fixture({ connectTimeoutMs: 500 }, () => new Promise(() => {}));
    await start();
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.state).toBe('reconnecting'); expect(clients[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); expect(clients).toHaveLength(2);
  });
  it('honors a finite retry budget and resets attempts only after real readiness', async () => {
    const { manager, start, clients } = fixture({ reconnectMaxAttempts: 2 });
    const failed = vi.fn(); manager.on('reconnectFailed', failed);
    await start(); clients[0].onError();
    await vi.advanceTimersByTimeAsync(100); clients[1].onError();
    await vi.advanceTimersByTimeAsync(200); clients[2].onError();
    expect(manager.state).toBe('stopped'); expect(failed).toHaveBeenCalledExactlyOnceWith(2);
    await vi.advanceTimersByTimeAsync(60_000); expect(clients).toHaveLength(3);
  });
  it('makes repeated starts idempotent and late events after stop inert', async () => {
    const { manager, start, clients } = fixture();
    await start(); await start(); expect(clients).toHaveLength(1);
    await manager.stop(); clients[0].onReady(); clients[0].onError(); clients[0].onReconnecting();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.state).toBe('stopped'); expect(clients).toHaveLength(1);
    await start(); clients[0].onReady(); expect(manager.isHealthy()).toBe(false);
    clients[1].onReady(); expect(manager.isHealthy()).toBe(true);
  });
  it.each(['false', 'rejection'])('handles SDK start %s as an unready retry', async (mode) => {
    const { manager, start } = fixture({}, () => mode === 'rejection' ? Promise.reject(new Error('fixture')) : Promise.resolve(false));
    await start(); await vi.advanceTimersByTimeAsync(0);
    expect(manager.state).toBe('reconnecting'); expect(manager.isHealthy()).toBe(false);
  });
  it('handles SDK constructor and start failures without an unhandled rejection', async () => {
    const { manager, start, construct } = fixture();
    construct.mockImplementationOnce(() => { throw new Error('private SDK error'); });
    await start(); expect(manager.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100); expect(manager.state).toBe('connecting');
  });
});

describe('initial DNS and cancellation (#5519)', () => {
  it('waits in the background and connects automatically after DNS recovers', async () => {
    const { manager, start, clients } = fixture({ dnsCheckHost: 'configured.example' });
    const probe = dnsProbe(manager).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await start(); expect(manager.state).toBe('waiting_dns'); expect(clients).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100); expect(clients).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200); expect(clients).toHaveLength(1);
    expect(probe).toHaveBeenCalledWith('configured.example');
    expect(manager.isHealthy()).toBe(false); clients[0].onReady(); expect(manager.isHealthy()).toBe(true);
  });
  it('does not continue an in-flight DNS attempt after stop or a new generation', async () => {
    const { manager, start, clients } = fixture({ dnsCheckHost: 'configured.example' });
    let release!: (ready: boolean) => void;
    const probe = dnsProbe(manager).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(false);
    await start(); expect(manager.state).toBe('waiting_dns');
    await manager.stop(); await start(); release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(0); expect(probe).toHaveBeenCalledTimes(2);
  });
  it('bounds a stuck resolver and cancels its own in-flight query on stop', async () => {
    vi.spyOn(dns.Resolver.prototype, 'resolve').mockReturnValue(new Promise(() => {}));
    const cancel = vi.spyOn(dns.Resolver.prototype, 'cancel').mockImplementation(() => {});
    const { manager, start, clients } = fixture({ dnsCheckHost: 'fixture.invalid', dnsTimeoutMs: 50 });
    await start(); expect(manager.state).toBe('waiting_dns');
    await vi.advanceTimersByTimeAsync(50); expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); // The next bounded query is pending.
    await manager.stop(); expect(cancel).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(0); expect(manager.state).toBe('stopped');
  });
  it('rechecks DNS before replacing a failed client', async () => {
    const { manager, start, clients } = fixture({ dnsCheckHost: 'configured.example' });
    const probe = dnsProbe(manager).mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
    await start(); await vi.advanceTimersByTimeAsync(0); clients[0].onError();
    await vi.advanceTimersByTimeAsync(100); expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200); expect(clients).toHaveLength(2); expect(probe).toHaveBeenCalledTimes(3);
  });
});

it('reproduces the actual installed SDK early-return behavior without any network (#5519)', async () => {
  const { manager } = fixture();
  const request = vi.fn().mockRejectedValue(Object.assign(new Error('offline fixture'), { code: 'ENOTFOUND' }));
  let actual!: lark.WSClient;
  class OfflineClient extends lark.WSClient {
    constructor(options: ConstructorParameters<typeof lark.WSClient>[0]) {
      super({ ...options, httpInstance: { request } as never }); actual = this;
    }
  }
  Object.assign(manager, { larkSDK: { WSClient: OfflineClient, LoggerLevel: lark.LoggerLevel } });
  await manager.start(new lark.EventDispatcher({}));
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalled(); expect(actual.getConnectionStatus().state).not.toBe('connected');
  expect(manager.isHealthy()).toBe(false); expect(manager.state).toBe('connecting');
});
