import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectBrowser, withBrowserLease } from './client.mjs';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });

describe('browser client lease heartbeat lifetime', () => {
  it('reports the pending IPC phase when the broker closes the socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-client-'));
    const socketPath = join(root, 'browser.sock');
    const server = createServer(peer => peer.on('data', () => peer.destroy()));
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      const client = await connectBrowser(socketPath);
      await expect(client.request('wait')).rejects.toThrow(/Browser IPC closed; in-flight outcome may be unknown \(pending=1, lastRequest=1:wait\)/u);
      client.close();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('waits for release acknowledgement without heartbeat teardown (in-flight=%s)', async inFlight => {
    vi.useFakeTimers();
    const execution = deferred(), release = deferred(), heartbeat = deferred();
    const client = {
      request: vi.fn((method: string) => {
        if (method === 'acquire') { return Promise.resolve({ state: 'queued' }); }
        if (method === 'heartbeat') { return heartbeat.promise; }
        if (method === 'release') { return release.promise; }
        return Promise.resolve();
      }),
      close: vi.fn(),
    };
    const queued = vi.fn();
    const run = withBrowserLease(client, () => execution.promise, queued);
    await vi.advanceTimersByTimeAsync(0);
    expect(queued).toHaveBeenCalledTimes(1);
    if (inFlight) { await vi.advanceTimersByTimeAsync(1000); }
    execution.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledWith('release');
    const heartbeatCount = client.request.mock.calls.filter(([method]) => method === 'heartbeat').length;
    if (inFlight) { heartbeat.reject(new Error('No held lease')); }
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.request.mock.calls.filter(([method]) => method === 'heartbeat')).toHaveLength(heartbeatCount);
    expect(client.close).not.toHaveBeenCalled();
    release.resolve();
    await run;
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still closes a failed heartbeat during execution and propagates execution failure', async () => {
    vi.useFakeTimers();
    const execution = deferred();
    const client = {
      request: vi.fn((method: string) => method === 'heartbeat'
        ? Promise.reject(new Error('Lease expired')) : Promise.resolve({ state: 'queued' })),
      close: vi.fn(() => execution.reject(new Error('IPC closed'))),
    };
    const rejected = expect(withBrowserLease(client, () => execution.promise)).rejects.toThrow('IPC closed');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(client.close).toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalledWith('release');
    expect(vi.getTimerCount()).toBe(0);
  });
});
