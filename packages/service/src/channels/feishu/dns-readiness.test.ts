import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { waitForDnsReady, waitForStartupReadiness } from './dns-readiness.js';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }));
vi.mock('@disclaude/core', () => ({
  createLogger: () => log,
}));

const ENOTFOUND = Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' });
const RESOLVED = { address: '1.2.3.4', family: 4 } as Awaited<ReturnType<typeof dns.lookup>>;

/** Track a pending promise's settlement without awaiting it blindly. */
function tracker<T>(promise: Promise<T>): { settled: boolean; result?: T } {
  const state: { settled: boolean; result?: T } = { settled: false };
  void promise.then((result) => { state.settled = true; state.result = result; });
  return state;
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('startup DNS readiness (#5519)', () => {
  it('retries with exponential backoff and never a fixed sleep', async () => {
    const lookup = vi.spyOn(dns, 'lookup')
      .mockRejectedValueOnce(ENOTFOUND)
      .mockRejectedValueOnce(ENOTFOUND)
      .mockResolvedValueOnce(RESOLVED);
    const promise = waitForDnsReady({ host: 'open.feishu.cn' });
    const state = tracker(promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup).toHaveBeenCalledTimes(1); // first probe is immediate
    await vi.advanceTimersByTimeAsync(499);
    expect(lookup).toHaveBeenCalledTimes(1); // 500 ms backoff not elapsed yet
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup).toHaveBeenCalledTimes(2); // then doubles per attempt
    await vi.advanceTimersByTimeAsync(999);
    expect(lookup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup).toHaveBeenCalledTimes(3);
    await expect(promise).resolves.toMatchObject({ ready: true, attempts: 3, aborted: false });
    expect(state.result?.lastErrorCode).toBeUndefined();
  });

  it('gives up honestly after the total bound and never invents readiness', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValue(ENOTFOUND);
    const promise = waitForDnsReady({ host: 'open.feishu.cn', totalTimeoutMs: 4_000 });
    // Backoff 500+1000+2000 → 4th failure at t=3500 exceeds the bound.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promise;
    expect(result).toMatchObject({ ready: false, aborted: false, lastErrorCode: 'ENOTFOUND' });
    expect(result.attempts).toBeGreaterThanOrEqual(3);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3_500);
    const calls = lookup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lookup.mock.calls.length).toBe(calls); // stopped, no busy loop
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, lastErrorCode: 'ENOTFOUND' }),
      expect.stringContaining('within the startup bound'),
    );
  });

  it('honours an AbortSignal without waiting out the current backoff interval', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValue(ENOTFOUND);
    const controller = new AbortController();
    const promise = waitForDnsReady({ host: 'open.feishu.cn', signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    controller.abort(); // wakes the 500 ms backoff sleep immediately
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ready: false, aborted: true });
    expect(lookup).toHaveBeenCalledTimes(1); // no probe after cancellation
  });
});

describe('startup connection readiness (#5519)', () => {
  it('reports available only after DNS and a real connection are both up', async () => {
    const lookup = vi.spyOn(dns, 'lookup')
      .mockRejectedValueOnce(ENOTFOUND)
      .mockResolvedValueOnce(RESOLVED);
    let connected = false;
    const promise = waitForStartupReadiness({
      host: 'open.feishu.cn',
      isConnectionReady: () => connected,
    });
    const state = tracker(promise);
    await vi.advanceTimersByTimeAsync(0); // DNS attempt 1 fails
    await vi.advanceTimersByTimeAsync(500); // DNS attempt 2 succeeds
    await vi.advanceTimersByTimeAsync(0); // connection probe 1: still down
    expect(state.settled).toBe(false); // DNS alone must not report available
    connected = true;
    await vi.advanceTimersByTimeAsync(500); // connection probe 2 succeeds
    await expect(promise).resolves.toMatchObject({ ready: true, dnsReady: true, aborted: false });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('never probes the connection while DNS is down and reports not ready after the bound', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValue(ENOTFOUND);
    const isConnectionReady = vi.fn(() => true);
    const promise = waitForStartupReadiness({
      host: 'open.feishu.cn',
      totalTimeoutMs: 4_000,
      isConnectionReady,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promise;
    expect(result).toMatchObject({ ready: false, dnsReady: false, aborted: false });
    expect(isConnectionReady).not.toHaveBeenCalled(); // connect only after DNS is ready
    expect(lookup.mock.calls.every(([host]) => host === 'open.feishu.cn')).toBe(true);
  });
});
