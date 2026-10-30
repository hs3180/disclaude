import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskClaimStore } from '@disclaude/core';
import { prepareClaimedTask, type ClaimedTaskPorts } from './claimed-task-admission.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claimed-admission-')); roots.push(root);
  const store = new TaskClaimStore(join(root, 'claims')), key = 'project/base/table/record';
  function prepare(extra: Partial<ClaimedTaskPorts<void>> = {}, revision = 0) {
    const drain = deferred(), authorize = vi.fn(), projection = vi.fn(async () => {}), stop = vi.fn();
    const start = vi.fn((owner: string) => ({ id: `native-${owner}`, completion: drain.promise, stop }));
    const attempt = prepareClaimedTask(store, key, revision, { authorize, ensureProjection: projection, start, ...extra });
    return { ...attempt, drain, authorize, projection, startNative: start, stop };
  }
  return { store, key, prepare };
}

it('admits exactly one worker only after atomic claim and confirmed board projection', async () => {
  const f = await fixture(), projection = deferred();
  const a = f.prepare({ ensureProjection: async () => { await projection.promise; } }), b = f.prepare();
  const first = a.start(); await vi.waitFor(async () => expect((await f.store.get(f.key)).owner).toBe(a.owner));
  await expect(b.start()).rejects.toThrow('another owner'); expect(b.startNative).not.toHaveBeenCalled();
  expect(a.startNative).not.toHaveBeenCalled(); projection.resolve();
  const handle = await first; expect(await a.start()).toBe(handle); expect(a.startNative).toHaveBeenCalledTimes(1);
  a.drain.resolve(); await a.release();
  const next = f.prepare({}, 2); await next.start(); expect(next.startNative).toHaveBeenCalledOnce(); next.drain.resolve();
});

it('reconciles unknown projection before execution without changing the claim or duplicating launch', async () => {
  const f = await fixture(), projections: unknown[] = []; let confirmed = false;
  const a = f.prepare({ ensureProjection: value => {
    projections.push(value); if (!confirmed) { confirmed = true; return Promise.reject(new Error('lost remote ACK after write')); }
    return Promise.resolve();
  } });
  await expect(a.start()).rejects.toThrow('remote ACK'); expect(a.startNative).not.toHaveBeenCalled();
  expect((await f.store.get(f.key)).owner).toBe(a.owner);
  await a.start(); expect(projections[0]).toEqual(projections[1]); expect(a.startNative).toHaveBeenCalledOnce();
  expect(JSON.stringify(projections)).not.toContain('claimId'); a.drain.resolve();
});

it('uses the same identity after a committed claim loses its acknowledgement', async () => {
  const f = await fixture(), claim = f.store.claim.bind(f.store);
  const publish = vi.spyOn(f.store, 'claim').mockImplementationOnce(async (...args) => { await claim(...args); throw new Error('lost claim ACK'); });
  const a = f.prepare(); await expect(a.start()).rejects.toThrow('claim ACK'); expect(a.startNative).not.toHaveBeenCalled();
  await a.start(); expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]); a.drain.resolve();
});

it('never retries or releases an uncertain native start', async () => {
  const f = await fixture(), start = vi.fn(() => { throw new Error('unknown native ACK'); }), a = f.prepare({ start });
  await expect(a.start()).rejects.toThrow('native ACK');
  await expect(a.start()).rejects.toThrow('uncertain'); await expect(a.release()).rejects.toThrow('uncertain');
  expect(start).toHaveBeenCalledOnce(); expect((await f.store.get(f.key)).owner).toBe(a.owner);
});

it('explicit release waits for physical execution drain and fences all subsequent starts', async () => {
  const f = await fixture(), a = f.prepare(); await a.start();
  let released = false; const completion = a.release().then(() => { released = true; });
  await Promise.resolve(); expect(released).toBe(false); expect((await f.store.get(f.key)).owner).toBe(a.owner);
  await expect(a.start()).rejects.toThrow('release'); a.drain.resolve(); await completion;
  expect(await a.release()).toMatchObject({ revision: 2 });
});

it('a release during pending projection prevents native launch', async () => {
  const f = await fixture(), projection = deferred(), entered = deferred();
  const a = f.prepare({ ensureProjection: async () => { entered.resolve(); await projection.promise; } });
  const work = a.start(); await entered.promise; const released = a.release(); projection.resolve();
  await expect(work).rejects.toThrow('release'); await released;
  expect(a.startNative).not.toHaveBeenCalled(); expect(await f.store.get(f.key)).toMatchObject({ revision: 2 });
});

it('checks permission before each side effect and retains an admitted claim after revocation', async () => {
  const f = await fixture(), authorize = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('revoked'); });
  const a = f.prepare({ authorize }); await expect(a.start()).rejects.toThrow('revoked');
  expect(a.projection).not.toHaveBeenCalled(); expect(a.startNative).not.toHaveBeenCalled();
  expect((await f.store.get(f.key)).owner).toBe(a.owner); await a.release();
  const b = f.prepare({ authorize: () => { throw new Error('revoked'); } }, 2);
  await expect(b.start()).rejects.toThrow('revoked'); expect((await f.store.get(f.key)).revision).toBe(2);
});

it('cancellation before launch retains the exact claim for explicit reconciliation', async () => {
  const f = await fixture(), abort = new AbortController();
  const a = f.prepare({ ensureProjection: () => { abort.abort(); return Promise.resolve(); } });
  await expect(a.start(abort.signal)).rejects.toThrow(); expect(a.startNative).not.toHaveBeenCalled();
  expect((await f.store.get(f.key)).owner).toBe(a.owner); await a.release();
});

it('retries an unknown release acknowledgement using the same lease without another execution', async () => {
  const f = await fixture(), a = f.prepare(); await a.start(); a.drain.resolve();
  const release = f.store.release.bind(f.store), writes = vi.spyOn(f.store, 'release').mockImplementationOnce(async lease => {
    await release(lease); throw new Error('lost release ACK');
  });
  await expect(a.release()).rejects.toThrow('release ACK'); expect(await a.release()).toMatchObject({ revision: 2 });
  expect(writes.mock.calls[0]).toEqual(writes.mock.calls[1]); expect(a.startNative).toHaveBeenCalledOnce();
});
