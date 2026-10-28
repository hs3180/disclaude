import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskClaimStore, TaskClaimConflictError } from './task-claim-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'task-claims-')); roots.push(root);
  const directory = join(root, 'claims');
  return { root, directory, store: new TaskClaimStore(directory) };
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); }
});

it('grants only one of two same-service workers and preserves the claim across recreation', async () => {
  const { directory, store } = await fixture();
  expect(await store.get('board/table/task')).toEqual({ key: 'board/table/task', revision: 0 });
  const other = new TaskClaimStore(directory);
  const outcomes = await Promise.allSettled([store.claim('board/table/task', 0, 'worker-a'), other.claim('board/table/task', 0, 'worker-b')]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  const failure = outcomes.find(item => item.status === 'rejected');
  expect(failure).toMatchObject({ reason: expect.any(TaskClaimConflictError) });
  const current = await new TaskClaimStore(directory).get('board/table/task');
  expect(current.revision).toBe(1); expect(['worker-a', 'worker-b']).toContain(current.owner);
  expect(Object.keys(current).sort()).toEqual(['key', 'owner', 'revision']);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  const [name] = await fs.readdir(directory);
  expect((await fs.stat(join(directory, name!))).mode & 0o777).toBe(0o600);
});

it('joins storage aliases into the same serial claim queue', async () => {
  const { root, directory, store } = await fixture(); await fs.mkdir(directory);
  await fs.symlink(root, join(root, 'alias'));
  const other = new TaskClaimStore(join(root, 'alias', 'claims'));
  const outcomes = await Promise.allSettled([store.claim('task', 0, 'a'), other.claim('task', 0, 'b')]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect((await store.get('task')).revision).toBe(1);
});

it('retries the same claim and release without replaying or advancing revision', async () => {
  const { store, directory } = await fixture(); const id = randomUUID();
  const lease = await store.claim('task', 0, 'a', id.toUpperCase());
  expect(lease.claimId).toBe(id);
  expect(await new TaskClaimStore(directory).claim('task', 0, 'a', id)).toEqual(lease);
  await expect(store.claim('task', 1, 'a')).rejects.toBeInstanceOf(TaskClaimConflictError);
  const released = await store.release(lease);
  expect(released).toEqual({ key: 'task', revision: 2 });
  expect(await new TaskClaimStore(directory).release({ ...lease, claimId: id.toUpperCase() })).toEqual(released);
  const [file] = await fs.readdir(directory);
  expect(await fs.readFile(join(directory, file!), 'utf8')).not.toContain(id);
});

it('fences delayed releases and wrong ownership after explicit re-claim', async () => {
  const { store } = await fixture(); const first = await store.claim('task', 0, 'a');
  for (const lease of [{ ...first, owner: 'b' }, { ...first, claimId: randomUUID() }, { ...first, revision: 2 }]) {
    await expect(store.release(lease)).rejects.toBeInstanceOf(TaskClaimConflictError);
  }
  await store.release(first);
  const second = await store.claim('task', 2, 'b');
  await expect(store.release(first)).rejects.toBeInstanceOf(TaskClaimConflictError);
  expect(await store.get('task')).toEqual({ key: 'task', revision: 3, owner: 'b' });
  await expect(store.claim('task', 0, 'a', first.claimId)).rejects.toBeInstanceOf(TaskClaimConflictError);
  await store.release(second);
});

it('isolates resource keys and never expires ownership based on the clock', async () => {
  const { store } = await fixture(); const first = await store.claim('board-a/task', 0, 'a');
  const second = await store.claim('board-b/task', 0, 'b');
  vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
  expect(await store.get(first.key)).toMatchObject({ revision: 1, owner: 'a' });
  await expect(store.claim(first.key, 1, 'b')).rejects.toBeInstanceOf(TaskClaimConflictError);
  vi.useRealTimers(); await store.release(first); await store.release(second);
});

it('does not read a queued release from a caller-mutated lease', async () => {
  const { store } = await fixture(); const lease = await store.claim('task', 0, 'a');
  const releasing = store.release(lease); lease.owner = 'other'; lease.claimId = randomUUID(); lease.key = 'other-task';
  expect(await releasing).toEqual({ key: 'task', revision: 2 });
  expect(await store.get('other-task')).toEqual({ key: 'other-task', revision: 0 });
});

it('preserves held state on a failed replacement and allows the exact explicit retry', async () => {
  const { store, directory } = await fixture(); const lease = await store.claim('task', 0, 'a');
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error('injected rename failure'));
  await expect(store.release(lease)).rejects.toThrow('injected rename failure');
  expect(await store.get('task')).toEqual({ key: 'task', revision: 1, owner: 'a' });
  expect(await fs.readdir(directory)).toHaveLength(1);
  expect(await store.release(lease)).toEqual({ key: 'task', revision: 2 });
});

it('does not publish a failed staging write or strand the service queue', async () => {
  const { store, directory } = await fixture();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let fail = true;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.tmp') && fail) {
      fail = false; vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('injected staging failure'));
    }
    return handle;
  });
  await expect(store.claim('task-a', 0, 'a')).rejects.toThrow('injected staging failure');
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await store.get('task-a')).toEqual({ key: 'task-a', revision: 0 });
  expect(await store.claim('task-b', 0, 'b')).toMatchObject({ revision: 1, owner: 'b' });
  expect(await store.claim('task-a', 0, 'a')).toMatchObject({ revision: 1, owner: 'a' });
});

it('does not wrap an exhausted revision or overwrite the prior record', async () => {
  const { store, directory } = await fixture(); const lease = await store.claim('task', 0, 'a');
  await store.release(lease);
  const [name] = await fs.readdir(directory); const file = join(directory, name!);
  const record = JSON.parse(await fs.readFile(file, 'utf8')) as object;
  const data = JSON.stringify({ ...record, revision: Number.MAX_SAFE_INTEGER });
  await fs.writeFile(file, data);
  await expect(store.claim('task', Number.MAX_SAFE_INTEGER, 'b')).rejects.toThrow('revision exhausted');
  expect(await fs.readFile(file, 'utf8')).toBe(data);
});

it('retains a published claim after an uncertain directory sync rather than granting another worker', async () => {
  const { store, directory } = await fixture(); const id = randomUUID();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let fail = true;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === directory && fail) {
      fail = false; vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected directory sync failure'));
    }
    return handle;
  });
  await expect(store.claim('task', 0, 'a', id)).rejects.toThrow('injected directory sync failure');
  expect(await new TaskClaimStore(directory).get('task')).toEqual({ key: 'task', revision: 1, owner: 'a' });
  await expect(store.claim('task', 0, 'b')).rejects.toBeInstanceOf(TaskClaimConflictError);
  expect(await store.claim('task', 0, 'a', id)).toMatchObject({ revision: 1, owner: 'a', claimId: id });
});

it('preserves malformed, oversized and foreign-key records without treating them as free', async () => {
  const { store, directory } = await fixture(); await store.claim('task', 0, 'a');
  const [name] = await fs.readdir(directory); const file = join(directory, name!);
  const original = JSON.parse(await fs.readFile(file, 'utf8')) as object;
  for (const data of ['{broken', 'x'.repeat(16385), JSON.stringify({ ...original, key: 'foreign' }),
    JSON.stringify({ ...original, owner: null, claimHash: null }), JSON.stringify({ ...original, maxDuration: 1 })]) {
    await fs.writeFile(file, data);
    await expect(store.get('task')).rejects.toThrow('Cannot read task claim');
    await expect(store.claim('task', 0, 'b')).rejects.toThrow('Cannot read task claim');
    expect(await fs.readFile(file, 'utf8')).toBe(data);
  }
});

it('rejects symlink storage and records without touching the target', async () => {
  const { root, directory, store } = await fixture(); await store.claim('task', 0, 'a');
  const [name] = await fs.readdir(directory); const file = join(directory, name!);
  const other = join(root, 'private-other'); await fs.writeFile(other, 'retain me'); await fs.unlink(file); await fs.symlink(other, file);
  await expect(store.claim('task', 0, 'b')).rejects.toThrow('Cannot read task claim');
  await fs.symlink(directory, join(root, 'linked'));
  await expect(new TaskClaimStore(join(root, 'linked')).claim('task', 0, 'b')).rejects.toThrow('real directory');
  expect(await fs.readFile(other, 'utf8')).toBe('retain me');
});

it('validates before creating storage and reads absent keys without side effects', async () => {
  const { directory, store } = await fixture();
  expect(() => new TaskClaimStore('relative')).toThrow('absolute');
  for (const input of [['', 0, 'a'], ['task', -1, 'a'], ['task', 0, ' '], ['task', 1.5, 'a']] as const) {
    await expect(store.claim(input[0], input[1], input[2])).rejects.toThrow('Invalid');
  }
  expect(await store.get('absent')).toEqual({ key: 'absent', revision: 0 });
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
