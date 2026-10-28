import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalStore, GoalRevisionConflictError } from './goal-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'disclaude-goal-')); roots.push(root);
  const directory = join(root, 'goals');
  return { root, directory, store: new GoalStore(directory) };
}
const goal = { chatId: 'chat-owner', projectRoot: '/project/selected', objective: 'Deliver the requested report', acceptance: ['Review the report', 'Record actual verification'] };
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });

describe('explicit durable goal records (#5212/F1)', () => {
  it('creates a private draft and preserves revised requirements, scope and progress across store recreation', async () => {
    const { directory, store } = await fixture();
    const first = await store.create(goal);
    expect(first).toMatchObject({ version: 1, revision: 1, status: 'draft', ...goal });
    const second = await store.update(first.id, 1, { acceptance: ['A revised acceptance condition'], progress: 'Draft reviewed', artifacts: ['https://example.test/report'] });
    expect(second.revision).toBe(2); expect(second.id).toBe(first.id);
    expect(second.chatId).toBe(first.chatId); expect(second.projectRoot).toBe(first.projectRoot);
    expect(await new GoalStore(directory).get(first.id)).toEqual(second);
    expect(await new GoalStore(directory).listIds()).toEqual([first.id]);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, `${first.id}.json`))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(directory))).toEqual([`${first.id}.json`]);
  });
  it('discovers identities without treating unknown or staging files as goals', async () => {
    const { directory, store } = await fixture(); const first = await store.create({ ...goal, projectRoot: undefined });
    await fs.writeFile(join(directory, 'owner-notes.txt'), 'retain me');
    await fs.writeFile(join(directory, '.interrupted.tmp'), 'retain staging evidence');
    expect(await store.listIds()).toEqual([first.id]);
    expect(await store.get(first.id)).toEqual(first);
    expect(await fs.readFile(join(directory, 'owner-notes.txt'), 'utf8')).toBe('retain me');
  });
  it('serializes updates through aliases of the storage parent', async () => {
    const { root, store } = await fixture(); const first = await store.create(goal);
    const alias = join(root, 'alias'); await fs.symlink(root, alias);
    const outcomes = await Promise.allSettled([store.update(first.id, 1, { progress: 'A' }), new GoalStore(join(alias, 'goals')).update(first.id, 1, { progress: 'B' })]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.get(first.id))?.revision).toBe(2);
  });
  it('never publishes a goal after staging write failure', async () => {
    const { directory, store } = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'ENOSPC' }));
      return handle;
    });
    await expect(store.create(goal)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await store.listIds()).toEqual([]); expect(await fs.readdir(directory)).toEqual([]);
    expect((await store.create(goal)).revision).toBe(1);
  });
  it('takes an immutable input snapshot before asynchronous file operations', async () => {
    const { store } = await fixture();
    const input = structuredClone(goal);
    const creating = store.create(input); input.acceptance[0] = 'Changed after submission';
    const first = await creating;
    expect(first.acceptance).toEqual(goal.acceptance);
    const patch = { acceptance: ['Latest feedback'] };
    const updating = store.update(first.id, 1, patch); patch.acceptance[0] = 'Changed after submission';
    const second = await updating; second.acceptance[0] = 'Changed returned value';
    expect((await store.get(first.id))?.acceptance).toEqual(['Latest feedback']);
  });
  it('allows only one of two writers in the owning process to update a revision', async () => {
    const { directory, store } = await fixture(); const first = await store.create(goal);
    const outcomes = await Promise.allSettled([store.update(first.id, 1, { progress: 'worker A' }), new GoalStore(directory).update(first.id, 1, { progress: 'worker B' })]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(GoalRevisionConflictError) });
    expect((await store.get(first.id))?.revision).toBe(2);
  });
  it('preserves the last record after a failed atomic replacement and permits a later valid update', async () => {
    const { directory, store } = await fixture(); const first = await store.create(goal);
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('private-path'), { code: 'ENOSPC' }));
    await expect(store.update(first.id, 1, { progress: 'uncommitted' })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await store.get(first.id)).toEqual(first);
    expect(await fs.readdir(directory)).toEqual([`${first.id}.json`]);
    expect((await store.update(first.id, 1, { progress: 'committed' })).revision).toBe(2);
  });
  it('fails closed for corrupt, mismatched, unsupported and oversized records without replacing them', async () => {
    const { directory, store } = await fixture(); const first = await store.create(goal); const file = join(directory, `${first.id}.json`);
    for (const contents of ['private-corrupt-body', JSON.stringify({ ...first, id: 'wrong-id' }), JSON.stringify({ ...first, version: 2 }), JSON.stringify({ ...first, tokenBudget: 100 }), 'x'.repeat(128 * 1024 + 1)]) {
      await fs.writeFile(file, contents);
      await expect(store.get(first.id)).rejects.toThrow('Cannot read goal record');
      await expect(store.update(first.id, 1, { progress: 'overwrite' })).rejects.toThrow('Cannot read goal record');
      expect(await fs.readFile(file, 'utf8')).toBe(contents);
    }
  });
  it('rejects traversal, symlink files and symlink storage roots', async () => {
    const { root, directory, store } = await fixture(); const first = await store.create(goal); const file = join(directory, `${first.id}.json`);
    await expect(store.get('../auth')).rejects.toThrow('Invalid goal ID');
    const other = join(root, 'untouched'); await fs.writeFile(other, 'private-other-content'); await fs.unlink(file); await fs.symlink(other, file);
    await expect(store.get(first.id)).rejects.toThrow('Cannot read goal record');
    const link = join(root, 'linked'); await fs.symlink(directory, link);
    await expect(new GoalStore(link).get(first.id)).rejects.toThrow('Cannot read goal record');
    await expect(new GoalStore(link).create(goal)).rejects.toThrow();
    expect(await fs.readFile(other, 'utf8')).toBe('private-other-content');
  });
  it('never mutates identity or lifecycle through content edits and never adds cost budgets', async () => {
    const { store } = await fixture(); const first = await store.create(goal);
    for (const patch of [{ chatId: 'other' }, { projectRoot: '/other' }, { status: 'completed' }, { tokenBudget: 1 }, { maxSteps: 1 }, { maxDuration: 1 }, { objective: '' }, { acceptance: [] }]) {
      await expect(store.update(first.id, 1, patch as never)).rejects.toThrow();
    }
    await expect(store.create({ ...goal, tokenBudget: 1 } as never)).rejects.toThrow();
    expect(await store.get(first.id)).toEqual(first);
  });
  it('rejects an oversized edit before replacing the current record', async () => {
    const { store } = await fixture(); const first = await store.create(goal);
    await expect(store.update(first.id, 1, { acceptance: Array(100).fill('x'.repeat(4_000)) })).rejects.toThrow('storage limit');
    expect(await store.get(first.id)).toEqual(first);
  });
  it('has no filesystem side effects when reading an absent goal', async () => {
    const { directory, store } = await fixture();
    expect(await store.listIds()).toEqual([]);
    expect(await store.get('00000000-0000-4000-8000-000000000000')).toBeUndefined();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
