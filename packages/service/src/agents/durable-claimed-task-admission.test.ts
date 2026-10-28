import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TaskAdmissionStore, TaskClaimStore } from '@disclaude/core';
import { prepareDurableClaimedTask } from './claimed-task-admission.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fingerprint = createHash('sha256').update('host bound complete plan').digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'durable-admission-')); roots.push(root);
  const admissions = new TaskAdmissionStore(join(root, 'intents')), claims = new TaskClaimStore(join(root, 'claims'));
  let finish!: () => void; const completion = new Promise<void>(resolve => { finish = resolve; });
  const native = { id: randomUUID(), completion, stop: vi.fn() };
  const ports = { authorize: vi.fn(), ensureProjection: vi.fn(async () => {}), start: vi.fn(() => native),
    recover: vi.fn(() => Promise.resolve(native)) };
  const options = { admissions, claims, operationKey: 'original-source/operation', fingerprint, claimKey: 'project/task', expectedClaimRevision: 0, ports };
  return { ...options, options, native, finish };
}

it('persists the exact claim before effects and returns the same native handle on retries', async () => {
  const f = await fixture();
  f.ports.ensureProjection.mockImplementationOnce(async () => {
    const saved = await f.admissions.get(f.operationKey); expect(saved?.phase).toBe('prepared');
    expect((await f.claims.get(f.claimKey)).owner).toBe(saved?.claim.owner);
  });
  const attempt = await prepareDurableClaimedTask(f.options), handle = await attempt.start();
  expect(await attempt.start()).toBe(handle); expect(f.ports.start).toHaveBeenCalledOnce();
  expect(await f.admissions.get(f.operationKey)).toMatchObject({ phase: 'admitted', nativeId: f.native.id });
  f.finish(); await attempt.release();
});

it('reconstructs after a projection ACK loss using the same private lease without repeating work', async () => {
  const f = await fixture(); f.ports.ensureProjection.mockRejectedValueOnce(new Error('lost board ACK'));
  const first = await prepareDurableClaimedTask(f.options); await expect(first.start()).rejects.toThrow('board ACK');
  const saved = await f.admissions.get(f.operationKey);
  const second = await prepareDurableClaimedTask({ ...f.options, admissions: new TaskAdmissionStore(f.admissions.directory), expectedClaimRevision: 1 });
  expect(second.owner).toBe(first.owner); await second.start(); expect(f.ports.start).toHaveBeenCalledOnce();
  expect((await f.admissions.get(f.operationKey))?.claim).toEqual(saved?.claim); f.finish(); await second.release();
});

it('recovers only the original execution and waits for its physical settlement before release', async () => {
  const f = await fixture(), first = await prepareDurableClaimedTask(f.options); await first.start();
  const recovered = await prepareDurableClaimedTask({ ...f.options, admissions: new TaskAdmissionStore(f.admissions.directory) });
  const handle = await recovered.start(); expect(handle.id).toBe(f.native.id); expect(f.ports.start).toHaveBeenCalledOnce();
  expect(f.ports.recover).toHaveBeenCalledWith(f.native.id);
  let released = false; const releasing = recovered.release().then(() => { released = true; });
  await Promise.resolve(); expect(released).toBe(false); f.finish(); await releasing;
});

it('retains native ownership when its receipt write fails and reconciles a lost ACK without replay', async () => {
  const f = await fixture(), confirm = f.admissions.confirmDispatch.bind(f.admissions);
  const saving = vi.spyOn(f.admissions, 'confirmDispatch').mockRejectedValueOnce(new Error('disk unavailable'));
  const attempt = await prepareDurableClaimedTask(f.options); await expect(attempt.start()).rejects.toThrow('disk unavailable');
  saving.mockImplementationOnce(async (...args) => { await confirm(...args); throw new Error('lost receipt ACK'); });
  await expect(attempt.start()).rejects.toThrow('receipt ACK'); saving.mockImplementation(confirm);
  expect((await attempt.start()).id).toBe(f.native.id); expect(f.ports.start).toHaveBeenCalledOnce();
  let released = false; const releasing = attempt.release().then(() => { released = true; });
  await Promise.resolve(); expect(released).toBe(false); f.finish(); await releasing;
});

it('never repeats or releases an unknown dispatch after reconstruction', async () => {
  const f = await fixture(); await f.admissions.prepare(f.operationKey, fingerprint, f.claimKey, 0);
  await f.admissions.beginDispatch(f.operationKey);
  const attempt = await prepareDurableClaimedTask(f.options);
  await expect(attempt.start()).rejects.toThrow('reconciliation'); await expect(attempt.release()).rejects.toThrow('uncertain');
  expect(f.ports.start).not.toHaveBeenCalled(); expect(f.ports.recover).not.toHaveBeenCalled();
});

it('refuses mismatched recovery receipts and rechecks permission after intent I/O', async () => {
  const f = await fixture(), first = await prepareDurableClaimedTask(f.options); await first.start();
  f.ports.recover.mockResolvedValueOnce({ ...f.native, id: randomUUID() });
  const second = await prepareDurableClaimedTask(f.options); await expect(second.start()).rejects.toThrow('reconciliation');
  expect(f.ports.start).toHaveBeenCalledOnce(); f.finish(); await first.release();
  const g = await fixture(), begin = g.admissions.beginDispatch.bind(g.admissions);
  vi.spyOn(g.admissions, 'beginDispatch').mockImplementationOnce(async key => {
    const value = await begin(key); g.ports.authorize.mockImplementation(() => { throw new Error('revoked'); }); return value;
  });
  const third = await prepareDurableClaimedTask(g.options); await expect(third.start()).rejects.toThrow('revoked');
  expect(g.ports.start).not.toHaveBeenCalled(); expect((await g.admissions.get(g.operationKey))?.phase).toBe('dispatching');
});
