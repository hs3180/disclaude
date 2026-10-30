import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalStore, GoalRevisionConflictError, type GoalRecord, type GoalTurnReport } from './goal-store.js';
import { GoalLoop } from './goal-loop.js';

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

describe('durable explicit goal controls (#5212/F3 storage)', () => {
  it('keeps pause across restart and requires an explicit resume while preserving updated requirements', async () => {
    const { directory, store } = await fixture(); const draft = await store.create(goal);
    const active = await store.control(draft.id, draft.revision, 'activate');
    const revised = await store.update(active.id, active.revision, { acceptance: ['User revised the requirement'], artifacts: ['report-v2'] });
    const paused = await store.control(revised.id, revised.revision, 'pause');
    const restarted = new GoalStore(directory);
    expect(await restarted.get(paused.id)).toEqual(paused);
    expect(paused).toMatchObject({ status: 'paused', revision: 4, acceptance: ['User revised the requirement'], artifacts: ['report-v2'], chatId: goal.chatId, projectRoot: goal.projectRoot });
    const resumed = await restarted.control(paused.id, paused.revision, 'resume');
    expect(resumed).toMatchObject({ status: 'active', revision: 5, id: draft.id, createdAt: draft.createdAt, acceptance: paused.acceptance });
    const stopped = await restarted.control(resumed.id, resumed.revision, 'stop');
    expect((await new GoalStore(directory).get(stopped.id))?.status).toBe('abandoned');
    await expect(restarted.control(stopped.id, stopped.revision, 'resume')).rejects.toThrow('terminal');
    await expect(restarted.update(stopped.id, stopped.revision, { progress: 'late worker result' })).rejects.toThrow('terminal');
  });
  it('rejects stale completion/progress and stale resume commands after pause or stop', async () => {
    const { store } = await fixture(); const draft = await store.create(goal);
    const active = await store.control(draft.id, draft.revision, 'activate');
    const paused = await store.control(active.id, active.revision, 'pause');
    await expect(store.update(active.id, active.revision, { progress: 'old completion' })).rejects.toBeInstanceOf(GoalRevisionConflictError);
    const edited = await store.update(paused.id, paused.revision, { objective: 'New user direction' });
    await expect(store.control(paused.id, paused.revision, 'resume')).rejects.toBeInstanceOf(GoalRevisionConflictError);
    const stopped = await store.control(edited.id, edited.revision, 'stop');
    await expect(store.control(edited.id, edited.revision, 'resume')).rejects.toBeInstanceOf(GoalRevisionConflictError);
    expect(await store.get(stopped.id)).toEqual(stopped);
  });
  it('shares one revision queue for content edits and controls even through parent aliases', async () => {
    const { root, directory, store } = await fixture(); const draft = await store.create(goal);
    const active = await store.control(draft.id, draft.revision, 'activate');
    const alias = join(root, 'alias'); await fs.symlink(root, alias);
    const outcomes = await Promise.allSettled([
      store.control(active.id, active.revision, 'pause'),
      new GoalStore(join(alias, 'goals')).update(active.id, active.revision, { progress: 'concurrent result' }),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(GoalRevisionConflictError) });
    const persisted = await new GoalStore(directory).get(active.id);
    expect(persisted?.revision).toBe(active.revision + 1);
    expect(persisted).toEqual((outcomes.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<GoalRecord>).value);
  });
  it('preserves the prior state when persisting pause fails, then allows a deliberate retry', async () => {
    const { directory, store } = await fixture(); const draft = await store.create(goal);
    const active = await store.control(draft.id, draft.revision, 'activate');
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'ENOSPC' }));
    await expect(store.control(active.id, active.revision, 'pause')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await store.get(active.id)).toEqual(active);
    expect(await fs.readdir(directory)).toEqual([`${active.id}.json`]);
    expect((await store.control(active.id, active.revision, 'pause')).status).toBe('paused');
  });
  it('never treats a command as task completion or silently activates a draft through resume', async () => {
    const { directory, store } = await fixture(); const draft = await store.create(goal);
    for (const action of ['resume', 'pause', 'complete', '__proto__']) {
      await expect(store.control(draft.id, draft.revision, action as never)).rejects.toThrow();
      expect(await store.get(draft.id)).toEqual(draft);
    }
    const blocked = { ...draft, status: 'blocked' };
    await fs.writeFile(join(directory, `${draft.id}.json`), JSON.stringify(blocked));
    expect((await store.control(draft.id, draft.revision, 'resume')).status).toBe('active');
    const completed = { ...draft, status: 'completed' };
    await fs.writeFile(join(directory, `${draft.id}.json`), JSON.stringify(completed));
    await expect(store.control(draft.id, draft.revision, 'activate')).rejects.toThrow('terminal');
    expect(await store.get(draft.id)).toEqual(completed);
  });
  it('stops a draft without running it and validates the revision before changing state', async () => {
    const { store } = await fixture(); const draft = await store.create(goal);
    for (const revision of [0, -1, NaN, 1.5]) {
      await expect(store.control(draft.id, revision, 'activate')).rejects.toThrow('revision');
    }
    expect((await store.control(draft.id, draft.revision, 'stop')).status).toBe('abandoned');
  });
  it('does not let an in-flight result undo pause, and a recreated driver stays idle until explicit resume', async () => {
    const { directory, store } = await fixture(); const draft = await store.create(goal);
    const active = await store.control(draft.id, draft.revision, 'activate');
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const runTurn = vi.fn(async (snapshot: Readonly<GoalRecord>) => {
      entered(); await gate;
      await expect(store.update(snapshot.id, snapshot.revision, { progress: 'late result' })).rejects.toBeInstanceOf(GoalRevisionConflictError);
    });
    const loop = new GoalLoop<GoalRecord>({ read: id => store.get(id), runTurn });
    const handle = loop.start(active.id); await started;
    const paused = await store.control(active.id, active.revision, 'pause'); release();
    expect(await handle.completion).toEqual({ reason: 'inactive', status: 'paused' });
    expect(runTurn).toHaveBeenCalledTimes(1);
    const restarted = new GoalStore(directory);
    let secondEntered!: () => void; const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
    let secondRelease!: () => void; const secondGate = new Promise<void>(resolve => { secondRelease = resolve; });
    const secondTurn = vi.fn(async () => { secondEntered(); await secondGate; });
    const recreated = new GoalLoop<GoalRecord>({ read: id => restarted.get(id), runTurn: secondTurn });
    expect(await recreated.start(active.id).completion).toEqual({ reason: 'inactive', status: 'paused' });
    expect(secondTurn).not.toHaveBeenCalled();
    const resumed = await restarted.control(paused.id, paused.revision, 'resume');
    const resumedHandle = recreated.start(active.id); await secondStarted;
    await restarted.control(resumed.id, resumed.revision, 'stop'); resumedHandle.stop();
    expect(recreated.start(active.id)).toBe(resumedHandle);
    secondRelease(); expect(await resumedHandle.completion).toEqual({ reason: 'stopped' });
    expect(await recreated.start(active.id).completion).toEqual({ reason: 'inactive', status: 'abandoned' });
    expect(secondTurn).toHaveBeenCalledTimes(1);
  });
});


describe('revision-bound settled turn assessments (#5212/F2)', () => {
  const report: GoalTurnReport = { outcome: 'completed', progress: 'All requested checks passed', artifacts: ['report.md', 'verification.log'],
    checks: [{ criterion: 0, satisfied: true, evidence: ['report.md'] }, { criterion: 1, satisfied: true, evidence: ['verification.log'] }] };
  async function activeFixture() {
    const result = await fixture(); const draft = await result.store.create(goal);
    return { ...result, active: await result.store.control(draft.id, draft.revision, 'activate') };
  }
  it('lets the driver continue with new progress and finish only after every criterion has evidence', async () => {
    const { directory, store, active } = await activeFixture();
    const runTurn = vi.fn(async (snapshot: Readonly<GoalRecord>) => {
      if (runTurn.mock.calls.length === 1) {
        await store.recordTurn(snapshot.id, snapshot.revision, { ...report, outcome: 'continue', checks: report.checks.slice(0, 1) });
      } else {
        expect(snapshot.progress).toBe(report.progress);
        expect(snapshot.lastAssessment?.outcome).toBe('continue');
        await store.recordTurn(snapshot.id, snapshot.revision, report);
      }
    });
    const handle = new GoalLoop({ read: id => store.get(id), runTurn }).start(active.id);
    expect(await handle.completion).toEqual({ reason: 'inactive', status: 'completed' });
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(await new GoalStore(directory).get(active.id)).toMatchObject({ status: 'completed', revision: 4,
      lastAssessment: { reviewedRevision: 3, outcome: 'completed', checks: report.checks } });
    await expect(store.update(active.id, 4, { progress: 'overwrite' })).rejects.toThrow('terminal');
  });
  it('persists a blocked outcome and waits for explicit resume rather than retrying', async () => {
    const { directory, store, active } = await activeFixture();
    const runTurn = vi.fn(async (snapshot: Readonly<GoalRecord>) => {
      await store.recordTurn(snapshot.id, snapshot.revision, { outcome: 'blocked', progress: 'Need the user to choose the data source', artifacts: [], checks: [] });
    });
    expect(await new GoalLoop({ read: id => store.get(id), runTurn }).start(active.id).completion).toEqual({ reason: 'inactive', status: 'blocked' });
    expect(runTurn).toHaveBeenCalledOnce();
    const restarted = new GoalStore(directory); const blocked = (await restarted.get(active.id))!;
    expect((await restarted.control(active.id, blocked.revision, 'resume')).status).toBe('active');
  });
  it.each(['pause', 'stop'] as const)('does not let a late report overwrite explicit %s', async action => {
    const { store, active } = await activeFixture();
    const changed = await store.control(active.id, active.revision, action);
    await expect(store.recordTurn(active.id, active.revision, report)).rejects.toBeInstanceOf(GoalRevisionConflictError);
    await expect(store.recordTurn(active.id, changed.revision, report)).rejects.toThrow();
    expect(await store.get(active.id)).toEqual(changed);
  });
  it('rejects a report based on requirements that the user has since revised', async () => {
    const { store, active } = await activeFixture();
    const revised = await store.update(active.id, active.revision, { acceptance: ['Use the new dataset'] });
    await expect(store.recordTurn(active.id, active.revision, report)).rejects.toBeInstanceOf(GoalRevisionConflictError);
    expect(await store.get(active.id)).toEqual(revised);
  });
  it('does not let a report start a draft or restart a completed goal', async () => {
    const { store } = await fixture(); const draft = await store.create(goal);
    await expect(store.recordTurn(draft.id, draft.revision, report)).rejects.toThrow('not active');
    const active = await store.control(draft.id, draft.revision, 'activate');
    const completed = await store.recordTurn(active.id, active.revision, report);
    await expect(store.recordTurn(completed.id, completed.revision, report)).rejects.toThrow('terminal');
  });
  it('requires complete, unique, in-range checks with recorded evidence before completion', async () => {
    const { store, active } = await activeFixture();
    const invalid = [
      { ...report, checks: [] }, { ...report, checks: report.checks.slice(0, 1) },
      { ...report, checks: [report.checks[0], report.checks[0]] },
      { ...report, checks: [{ criterion: 2, satisfied: true, evidence: ['report.md'] }] },
      { ...report, checks: [{ criterion: -1, satisfied: true, evidence: ['report.md'] }] },
      { ...report, checks: [{ criterion: 0.5, satisfied: true, evidence: ['report.md'] }] },
      { ...report, checks: report.checks.map(check => ({ ...check, satisfied: false })) },
      { ...report, checks: report.checks.map(check => ({ ...check, evidence: [] })) },
      { ...report, checks: report.checks.map(check => ({ ...check, evidence: ['unrecorded.log'] })) },
      { ...report, checks: [{ criterion: 0, satisfied: 'true', evidence: ['report.md'] }] },
      { ...report, checks: [{ ...report.checks[0], extra: 'untrusted' }] },
      { ...report, progress: '' }, { ...report, status: 'completed' }, { ...report, outcome: '__proto__' },
    ];
    for (const input of invalid) {
      await expect(store.recordTurn(active.id, active.revision, input as GoalTurnReport)).rejects.toThrow();
      expect(await store.get(active.id)).toEqual(active);
    }
  });
  it('clears stale assessment references when any content changes', async () => {
    const { store, active } = await activeFixture();
    const assessed = await store.recordTurn(active.id, active.revision, { ...report, outcome: 'continue' });
    const edited = await store.update(active.id, assessed.revision, { artifacts: ['replacement.md'] });
    expect(edited).not.toHaveProperty('lastAssessment');
    expect(await store.get(active.id)).toEqual(edited);
  });
  it('snapshots report inputs and does not expose mutable stored assessment arrays', async () => {
    const { store, active } = await activeFixture(); const input = structuredClone(report);
    const writing = store.recordTurn(active.id, active.revision, input);
    input.checks[0].evidence[0] = 'changed'; input.artifacts.length = 0;
    const completed = await writing;
    completed.lastAssessment!.checks[0].evidence[0] = 'changed returned value';
    expect((await store.get(active.id))?.lastAssessment?.checks).toEqual(report.checks);
  });
  it('allows only one assessment to win a revision across store instances', async () => {
    const { directory, store, active } = await activeFixture();
    const results = await Promise.allSettled([store.recordTurn(active.id, active.revision, report),
      new GoalStore(directory).recordTurn(active.id, active.revision, { ...report, outcome: 'continue' })]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(item => item.status === 'rejected')).toMatchObject({ reason: expect.any(GoalRevisionConflictError) });
  });
  it('preserves active state after report publication fails and permits a deliberate retry', async () => {
    const { store, active } = await activeFixture();
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'ENOSPC' }));
    await expect(store.recordTurn(active.id, active.revision, report)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await store.get(active.id)).toEqual(active);
    expect((await store.recordTurn(active.id, active.revision, report)).status).toBe('completed');
  });
  it('preserves malformed persisted assessment data without accepting or replacing it', async () => {
    const { directory, store, active } = await activeFixture();
    const file = join(directory, `${active.id}.json`);
    for (const lastAssessment of [{ reviewedRevision: 2, outcome: 'completed', checks: [] },
      { reviewedRevision: 1, outcome: 'completed', checks: [] },
      { reviewedRevision: 1, outcome: 'continue', checks: [{ criterion: 99, satisfied: false, evidence: [] }] }]) {
      const content = JSON.stringify({ ...active, lastAssessment }); await fs.writeFile(file, content);
      await expect(store.get(active.id)).rejects.toThrow('Cannot read goal record');
      await expect(store.recordTurn(active.id, active.revision, report)).rejects.toThrow('Cannot read goal record');
      expect(await fs.readFile(file, 'utf8')).toBe(content);
    }
  });
});
