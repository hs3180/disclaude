import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskClaimStore } from '@disclaude/core';
import { prepareTools } from '../../../core/src/sdk/tools.js';
import { createWorkerTaskClaims, type WorkerTaskClaimsOptions } from './worker-task-claims.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const context = () => ({ signal: new AbortController().signal });
const task = { id: 'task-A', key: JSON.stringify(['/fixture/project', 'base', 'table', 'record-A']) };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'worker-claims-')); roots.push(root);
  const store = new TaskClaimStore(join(root, 'claims'));
  function worker(extra: Partial<WorkerTaskClaimsOptions> = {}) {
    const drain = deferred(), id = randomUUID(), authorize = vi.fn();
    const binding = createWorkerTaskClaims({ store, worker: { id, completion: drain.promise }, tasks: [task], authorize, ...extra });
    const [tool] = prepareTools([binding.tool]);
    return { ...binding, tool, drain, id, authorize,
      get: () => tool.execute({ action: 'get', taskId: task.id }, context()),
      claim: (revision = 0) => tool.execute({ action: 'claim', taskId: task.id, expectedRevision: revision }, context()) };
  }
  return { root, store, worker };
}

it('lets only one host-bound worker win and exposes no claim credential or resource key', async () => {
  const f = await setup(), a = f.worker(), b = f.worker();
  expect(await a.get()).toEqual({ taskId: task.id, revision: 0 });
  const result = await Promise.allSettled([a.claim(), b.claim()]);
  expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  const owner = result[0].status === 'fulfilled' ? a : b;
  const view = await owner.get(); expect(view).toEqual({ taskId: task.id, revision: 1, owner: owner.id });
  expect(JSON.stringify(view)).not.toContain('claimId'); expect(JSON.stringify(view)).not.toContain('record-A');
  expect(await owner.claim()).toEqual(view); expect((await f.store.get(task.key)).revision).toBe(1);
  a.drain.resolve(); b.drain.resolve();
});

it('holds ownership until physical drain, then explicitly releases and fences delayed release', async () => {
  const f = await setup(), a = f.worker(); await a.claim();
  let released = false;
  const release = a.release(task.id).then(value => { released = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(released).toBe(false); expect((await f.store.get(task.key)).owner).toBe(a.id);
  a.drain.resolve(); expect(await release).toMatchObject({ revision: 2 });
  expect(await a.release(task.id)).toMatchObject({ revision: 2 });
  const b = f.worker(); expect(await b.claim(2)).toMatchObject({ revision: 3, owner: b.id });
  await expect(a.release(task.id)).rejects.toThrow('changed');
  expect((await f.store.get(task.key)).owner).toBe(b.id); b.drain.resolve();
});

it('reconciles a committed claim with lost acknowledgement using the same private attempt', async () => {
  const f = await setup(); const claim = f.store.claim.bind(f.store);
  const publish = vi.spyOn(f.store, 'claim').mockImplementationOnce(async (...args) => { await claim(...args); throw new Error('lost ACK'); });
  const a = f.worker(); await expect(a.claim()).rejects.toThrow('lost ACK');
  expect(await a.claim()).toMatchObject({ owner: a.id, revision: 1 });
  expect(publish.mock.calls[0][3]).toBe(publish.mock.calls[1][3]);
  a.drain.resolve(); expect(await a.release(task.id)).toMatchObject({ revision: 2 });
});

it('can release an unknown committed attempt after drain without a second claim', async () => {
  const f = await setup(); const claim = f.store.claim.bind(f.store);
  const publish = vi.spyOn(f.store, 'claim').mockImplementationOnce(async (...args) => { await claim(...args); throw new Error('lost ACK'); });
  const a = f.worker(); await expect(a.claim()).rejects.toThrow('lost ACK');
  a.drain.resolve(); await a.release(task.id); expect(publish).toHaveBeenCalledTimes(1);
  expect(await f.store.get(task.key)).toEqual({ key: task.key, revision: 2 });
});

it('preserves a previous worker across service reconstruction instead of adopting or replaying it', async () => {
  const f = await setup(), a = f.worker(); await a.claim(); a.drain.resolve();
  const rebuilt = new TaskClaimStore(join(f.root, 'claims')), b = f.worker({ store: rebuilt });
  expect(await b.get()).toMatchObject({ owner: a.id, revision: 1 });
  await expect(b.claim(1)).rejects.toThrow('another owner'); b.drain.resolve();
  await expect(b.release(task.id)).rejects.toThrow('changed');
  expect((await rebuilt.get(task.key)).owner).toBe(a.id);
});

it('checks current authorization and refuses cancellation, scope and model identity injection', async () => {
  const f = await setup(), a = f.worker();
  a.authorize.mockImplementation(() => { throw new Error('Project permission revoked'); });
  await expect(a.claim()).rejects.toThrow('revoked'); expect((await f.store.get(task.key)).revision).toBe(0);
  a.authorize.mockImplementation(() => {});
  for (const input of [{ action: 'claim', taskId: 'other', expectedRevision: 0 },
    { action: 'claim', taskId: task.id, expectedRevision: 0, owner: 'forged' },
    { action: 'release', taskId: task.id }, { action: 'claim', taskId: task.id }]) {
    await expect(a.tool.execute(input, context())).rejects.toThrow();
  }
  const abort = new AbortController(); abort.abort();
  await expect(a.tool.execute({ action: 'claim', taskId: task.id, expectedRevision: 0 }, { signal: abort.signal })).rejects.toThrow();
  expect((await f.store.get(task.key)).revision).toBe(0);
  await a.claim(); a.drain.resolve();
  a.authorize.mockImplementation(() => { throw new Error('Project permission revoked'); });
  await expect(a.release(task.id)).rejects.toThrow('revoked'); expect((await f.store.get(task.key)).owner).toBe(a.id);
});

it('keeps a committed claim when authorization is revoked or the tool reply is cancelled', async () => {
  const f = await setup(), a = f.worker();
  a.authorize.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('revoked after write'); });
  await expect(a.claim()).rejects.toThrow('revoked after write'); expect((await f.store.get(task.key)).owner).toBe(a.id);
  a.drain.resolve(); await a.release(task.id);
  const abort = new AbortController(), original = f.store.claim.bind(f.store), b = f.worker();
  vi.spyOn(f.store, 'claim').mockImplementationOnce(async (...args) => { const receipt = await original(...args); abort.abort(); return receipt; });
  await expect(b.tool.execute({ action: 'claim', taskId: task.id, expectedRevision: 2 }, { signal: abort.signal })).rejects.toThrow();
  expect((await f.store.get(task.key)).owner).toBe(b.id); b.drain.resolve(); await b.release(task.id);
});

it('freezes scope, rejects ended workers and permits release after a failed settled execution', async () => {
  const f = await setup(), mutable = { ...task }, drain = deferred();
  const a = f.worker({ tasks: [mutable], worker: { id: randomUUID(), completion: drain.promise.then(() => { throw new Error('worker failed after drain'); }) } });
  mutable.key = 'different-resource'; await a.claim(); expect((await f.store.get(task.key)).revision).toBe(1);
  drain.resolve(); await a.release(task.id);
  await expect(a.claim()).rejects.toThrow('settled'); expect((await f.store.get(task.key)).revision).toBe(2);
  const b = f.worker(); b.drain.resolve(); await Promise.resolve();
  await expect(b.claim(2)).rejects.toThrow('settled'); await expect(b.release(task.id)).rejects.toThrow('no claim');
});

it('rejects ambiguous host scope and non-native owner identities', async () => {
  const f = await setup();
  expect(() => f.worker({ tasks: [task, { ...task }] })).toThrow('unique');
  expect(() => f.worker({ tasks: [task, { ...task, id: 'alias' }] })).toThrow('unique');
  expect(() => f.worker({ worker: { id: 'model-owner', completion: Promise.resolve() } })).toThrow('host-created');
});
