import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TaskAdmissionStore } from './task-admission-store.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const fingerprint = createHash('sha256').update('complete source, task, criteria and route').digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'task-admission-')); roots.push(root);
  const store = new TaskAdmissionStore(join(root, 'intents')); return { root, store };
}

it('persists private claim credentials before dispatch and retains them on reconstruction/retry', async () => {
  const { root, store } = await fixture(), first = await store.prepare('operation', fingerprint, 'claim-key', 0);
  expect(first.phase).toBe('prepared'); expect(first.claim.revision).toBe(1);
  const rebuilt = new TaskAdmissionStore(store.directory);
  expect(await rebuilt.get('operation')).toEqual(first);
  expect(await rebuilt.prepare('operation', fingerprint, 'claim-key', 1)).toEqual(first);
  const alias = join(root, 'alias'); await fs.symlink(root, alias, 'dir');
  const parentAlias = new TaskAdmissionStore(join(alias, 'intents'));
  expect(await parentAlias.prepare('operation', fingerprint, 'claim-key', 5)).toEqual(first);
  expect((await fs.stat(store.directory)).mode & 0o777).toBe(0o700);
  const [file] = await fs.readdir(store.directory); expect((await fs.stat(join(store.directory, file))).mode & 0o777).toBe(0o600);
});

it('grants exactly one native dispatch and never grants a recovered or concurrent intent again', async () => {
  const { root, store } = await fixture();
  const prepared = await Promise.all(Array.from({ length: 8 }, () => store.prepare('operation', fingerprint, 'claim-key', 0)));
  expect(prepared.every(value => JSON.stringify(value) === JSON.stringify(prepared[0]))).toBe(true);
  const alias = join(root, 'parent-alias'); await fs.symlink(root, alias, 'dir');
  const begun = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    new TaskAdmissionStore(index % 2 ? store.directory : join(alias, 'intents')).beginDispatch('operation')));
  expect(begun.filter(value => value.dispatch)).toHaveLength(1);
  expect((await new TaskAdmissionStore(store.directory).beginDispatch('operation')).dispatch).toBe(false);
  const id = randomUUID(), receipt = await store.confirmDispatch('operation', id);
  expect(receipt).toMatchObject({ phase: 'admitted', nativeId: id });
  expect(await store.confirmDispatch('operation', id)).toEqual(receipt);
  expect((await store.beginDispatch('operation')).dispatch).toBe(false);
  await expect(store.confirmDispatch('operation', randomUUID())).rejects.toThrow('another native');
});

it('refuses changed work, missing intents, premature/fake receipts and invalid plans', async () => {
  const { store } = await fixture(); await store.prepare('operation', fingerprint, 'claim-key', 0);
  await expect(store.prepare('operation', 'f'.repeat(64), 'claim-key', 0)).rejects.toThrow('different work');
  await expect(store.prepare('operation', fingerprint, 'other-task', 0)).rejects.toThrow('different work');
  await expect(store.beginDispatch('missing')).rejects.toThrow('not found');
  await expect(store.confirmDispatch('operation', randomUUID())).rejects.toThrow('No native');
  await expect(store.confirmDispatch('operation', 'model-claim')).rejects.toThrow('receipt');
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER]) { expect(() => store.prepare('other', fingerprint, 'key', revision)).toThrow(); }
  expect(() => store.prepare('other', 'raw task', 'key', 0)).toThrow();
  expect(() => new TaskAdmissionStore('relative')).toThrow();
});

it('keeps the old durable intent on write failure and does not admit dispatch prematurely', async () => {
  const { store } = await fixture(), original = await store.prepare('operation', fingerprint, 'claim-key', 0);
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error('disk full'));
  await expect(store.beginDispatch('operation')).rejects.toThrow('disk full');
  expect(await store.get('operation')).toEqual(original);
  expect((await store.beginDispatch('operation')).dispatch).toBe(true);
});

it('reconciles claim persistence ACK loss but never repeats an unknown native dispatch', async () => {
  const { store } = await fixture(); const link = vi.mocked(fs.link).getMockImplementation()!;
  vi.mocked(fs.link).mockImplementationOnce(async (...args) => { await link(...args); throw new Error('lost create ACK'); });
  await expect(store.prepare('operation', fingerprint, 'claim-key', 0)).rejects.toThrow('create ACK');
  const saved = await store.get('operation'); expect(await store.prepare('operation', fingerprint, 'claim-key', 1)).toEqual(saved);
  const rename = vi.mocked(fs.rename).getMockImplementation()!;
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('lost dispatch ACK'); });
  await expect(store.beginDispatch('operation')).rejects.toThrow('dispatch ACK');
  expect((await store.beginDispatch('operation')).dispatch).toBe(false);
  expect((await store.get('operation'))?.claim).toEqual(saved?.claim);
  const nativeId = randomUUID();
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('lost native receipt ACK'); });
  await expect(store.confirmDispatch('operation', nativeId)).rejects.toThrow('receipt ACK');
  expect(await store.confirmDispatch('operation', nativeId)).toMatchObject({ phase: 'admitted', nativeId });
  expect((await store.beginDispatch('operation')).dispatch).toBe(false);
});

it('fails closed on corrupt records and filesystem redirects', async () => {
  const { root, store } = await fixture(); await store.prepare('operation', fingerprint, 'claim-key', 0);
  const [name] = await fs.readdir(store.directory), file = join(store.directory, name);
  const original = await fs.readFile(file, 'utf8'); await fs.writeFile(file, '{broken');
  await expect(store.get('operation')).rejects.toThrow('privately restore');
  const outside = join(root, 'outside.json'); await fs.writeFile(outside, original); await fs.rm(file); await fs.symlink(outside, file);
  await expect(store.beginDispatch('operation')).rejects.toThrow('privately restore');
  const alias = join(root, 'redirect'); await fs.symlink(store.directory, alias, 'dir');
  await expect(new TaskAdmissionStore(alias).prepare('new', fingerprint, 'key', 0)).rejects.toThrow('real directory');
});
