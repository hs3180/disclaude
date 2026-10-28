import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalController, type GoalExecutionRequest, type GoalExecutionPort } from './goal-controller.js';
import { GoalStore, type GoalTurnReport } from './goal-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = []; const controllers: GoalController[] = []; const releases: Array<() => void> = [];
function gate() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release); return { promise, release };
}
const completed: GoalTurnReport = { outcome: 'completed', progress: 'Artifact verified', artifacts: ['result.md'],
  checks: [{ criterion: 0, satisfied: true, evidence: ['result.md'] }] };
async function fixture(run = vi.fn().mockResolvedValue(completed)) {
  const root = await fs.mkdtemp(join(tmpdir(), 'disclaude-goal-controller-')); roots.push(root);
  const store = new GoalStore(join(root, 'goals'));
  const draft = await store.create({ chatId: 'chat', projectRoot: root, objective: 'Deliver an artifact', acceptance: ['Verify the artifact'] });
  const authorize = vi.fn().mockResolvedValue(undefined);
  const controller = new GoalController(store, { authorize, runTurn: run }); controllers.push(controller);
  const request: GoalExecutionRequest = { goalId: draft.id, expectedRevision: draft.revision, chatId: 'chat',
    projectRoot: root, actorId: 'user', sourceMessageId: 'source' };
  return { root, store, draft, run, authorize, controller, request };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) { release(); }
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
  for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); }
});

describe('owned explicit Goal execution', () => {
  it('runs multiple settled turns without new input and durably records completion', async () => {
    const run = vi.fn().mockResolvedValueOnce({ ...completed, outcome: 'continue' })
      .mockResolvedValueOnce({ ...completed, outcome: 'continue' }).mockResolvedValueOnce(completed);
    const { controller, store, request } = await fixture(run);
    const started = await controller.start(request, 'activate');
    expect(started.record.status).toBe('active');
    expect(await started.handle.completion).toEqual({ reason: 'inactive', status: 'completed' });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([2, 3, 4]);
    expect((await store.get(request.goalId))?.lastAssessment?.reviewedRevision).toBe(4);
  });
  it('deduplicates an identical admission while refusing another source or a premature resume', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request } = await fixture(run);
    const first = controller.start(request, 'activate');
    expect(controller.start({ ...request }, 'activate')).toBe(first);
    const { handle } = await first;
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await expect(controller.start({ ...request, sourceMessageId: 'another' }, 'activate')).rejects.toThrow('still owns');
    task.release(); await handle.completion;
  });
  it('persists pause immediately but retains ownership until uncooperative native work settles', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, store } = await fixture(run);
    const started = await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const paused = await controller.control({ ...request, expectedRevision: 2, sourceMessageId: 'pause' }, 'pause');
    expect(paused.record.status).toBe('paused');
    await vi.waitFor(() => expect(run.mock.calls[0][2].aborted).toBe(true));
    let settled = false; void paused.settlement!.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await expect(controller.start({ ...request, expectedRevision: 3 }, 'resume')).rejects.toThrow('still owns');
    task.release(); expect(await started.handle.completion).toEqual({ reason: 'stopped' });
    expect(await store.get(request.goalId)).toEqual(paused.record);
    run.mockImplementation(() => Promise.resolve(completed));
    const resumed = await controller.start({ ...request, expectedRevision: 3, sourceMessageId: 'resume' }, 'resume');
    expect(await resumed.handle.completion).toEqual({ reason: 'inactive', status: 'completed' });
  });
  it('does not cancel native work when persisting pause fails', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, store } = await fixture(run);
    await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'ENOSPC' }));
    await expect(controller.control({ ...request, expectedRevision: 2 }, 'pause')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(run.mock.calls[0][2].aborted).toBe(false); expect((await store.get(request.goalId))?.status).toBe('active');
    const paused = await controller.control({ ...request, expectedRevision: 2 }, 'pause'); task.release();
    expect(await paused.settlement).toEqual({ reason: 'stopped' });
  });

  it('keeps stop terminal and discards a cancelled turn report', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, store } = await fixture(run);
    const started = await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const stopped = await controller.control({ ...request, expectedRevision: 2 }, 'stop'); task.release();
    await stopped.settlement; expect(await store.get(request.goalId)).toEqual(stopped.record);
    expect(await started.handle.completion).toEqual({ reason: 'stopped' });
    expect(run).toHaveBeenCalledOnce();
  });
  it('rejects foreign chat/Project scope and missing actors before authorizing or executing', async () => {
    const { controller, request, authorize, run } = await fixture();
    for (const patch of [{ chatId: 'another-chat' }, { projectRoot: '/another-project' }, { actorId: '' }, { expectedRevision: 0 }]) {
      await expect(controller.start({ ...request, ...patch }, 'activate')).rejects.toThrow();
    }
    expect(authorize).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it('checks authority for activation and each execution and refuses a revoked control', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, authorize, store } = await fixture(run);
    authorize.mockRejectedValueOnce(new Error('denied'));
    await expect(controller.start(request, 'activate')).rejects.toThrow('denied');
    expect((await store.get(request.goalId))?.status).toBe('draft');
    const started = await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    authorize.mockRejectedValueOnce(new Error('revoked'));
    await expect(controller.control({ ...request, expectedRevision: 2 }, 'pause')).rejects.toThrow('revoked');
    expect((await store.get(request.goalId))?.status).toBe('active'); task.release(); await started.handle.completion;
    expect(authorize.mock.calls.map(([, owner]) => owner.actorId)).toEqual(['user', 'user', 'user', 'user', 'user']);
  });
  it('cannot certify completion when authority is revoked during native execution', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, authorize, store } = await fixture(run);
    const started = await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    authorize.mockRejectedValueOnce(new Error('revoked')); task.release();
    expect(await started.handle.completion).toMatchObject({ reason: 'failed', error: expect.any(Error) });
    expect((await store.get(request.goalId))?.status).toBe('active'); expect(run).toHaveBeenCalledOnce();
  });
  it('reads feedback arriving during authorization before dispatching any work', async () => {
    const checking = gate(); const { controller, request, authorize, store, run } = await fixture();
    authorize.mockImplementationOnce(() => checking.promise);
    const pending = controller.start(request, 'activate');
    await store.update(request.goalId, 1, { objective: 'New user direction' }); checking.release();
    await expect(pending).rejects.toThrow('Goal changed'); expect(run).not.toHaveBeenCalled();
  });
  it('re-reads feedback that arrives while checking authority for a round', async () => {
    const checking = gate(); const { controller, request, authorize, store, run } = await fixture();
    authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(() => checking.promise);
    const started = await controller.start(request, 'activate');
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    await store.update(request.goalId, 2, { objective: 'The latest user direction' }); checking.release();
    expect(await started.handle.completion).toEqual({ reason: 'inactive', status: 'completed' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toMatchObject({ revision: 3, objective: 'The latest user direction' });
  });

  it('does not overwrite new user requirements with an old settled result or automatically retry it', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, store } = await fixture(run);
    const started = await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const revised = await store.update(request.goalId, 2, { acceptance: ['The revised requirement'] }); task.release();
    expect(await started.handle.completion).toMatchObject({ reason: 'failed', error: expect.any(Error) });
    expect(await store.get(request.goalId)).toEqual(revised); expect(run).toHaveBeenCalledOnce();
  });
  it('does not replay a failed or restored active execution', async () => {
    const run = vi.fn().mockRejectedValue(new Error('native outcome unknown'));
    const { controller, request, store } = await fixture(run);
    const started = await controller.start(request, 'activate');
    expect(await started.handle.completion).toMatchObject({ reason: 'failed' });
    const restored = new GoalController(store, { authorize: vi.fn().mockResolvedValue(undefined), runTurn: run }); controllers.push(restored);
    await expect(restored.start({ ...request, expectedRevision: 2 }, 'resume')).rejects.toThrow('current state');
    expect(run).toHaveBeenCalledOnce(); expect((await store.get(request.goalId))?.status).toBe('active');
  });
  it('awaits owned cancellation on close, refuses new starts and preserves the user state', async () => {
    const task = gate(); const run = vi.fn<GoalExecutionPort['runTurn']>(async () => { await task.promise; return completed; });
    const { controller, request, store } = await fixture(run);
    const started = await controller.start(request, 'activate'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const closing = controller.close(); expect(controller.close()).toBe(closing);
    let closed = false; void closing.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    await expect(controller.start(request, 'activate')).rejects.toThrow('closing');
    task.release(); await closing; expect(await started.handle.completion).toEqual({ reason: 'stopped' });
    expect((await store.get(request.goalId))?.status).toBe('active');
  });
  it('settles stop safely when a pending activation loses its revision', async () => {
    const checking = gate(); const { controller, request, authorize, store, run } = await fixture();
    authorize.mockImplementationOnce(() => checking.promise);
    const pending = controller.start(request, 'activate');
    const rejected = expect(pending).rejects.toThrow('Goal changed');
    const stopped = await controller.control({ ...request, sourceMessageId: 'stop' }, 'stop');
    checking.release(); await rejected;
    expect(await stopped.settlement).toMatchObject({ reason: 'failed', error: expect.any(Error) });
    expect((await store.get(request.goalId))?.status).toBe('abandoned'); expect(run).not.toHaveBeenCalled();
  });

  it('does not activate after close while initial authority checking is pending', async () => {
    const checking = gate(); const { controller, request, authorize, store, run } = await fixture();
    authorize.mockImplementationOnce(() => checking.promise);
    const pending = controller.start(request, 'activate'); const closing = controller.close();
    checking.release(); await expect(pending).rejects.toThrow('closing'); await closing;
    expect((await store.get(request.goalId))?.status).toBe('draft'); expect(run).not.toHaveBeenCalled();
  });
});
