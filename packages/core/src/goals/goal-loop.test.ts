import { describe, expect, it, vi } from 'vitest';
import { GoalLoop, type GoalLoopPort } from './goal-loop.js';

const active = () => ({ id: 'goal', revision: 1, status: 'active', objective: 'Initial requirements', acceptance: ['Initial acceptance'] });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

describe('goal continuation component (#5212/F2)', () => {
  it('continues three turn settlements without new input and reads the newest requirements each round', async () => {
    const latest = active(); const snapshots: ReturnType<typeof active>[] = [];
    const runTurn = vi.fn((snapshot: ReturnType<typeof active>) => {
      snapshots.push(snapshot); latest.revision++;
      latest.objective = 'Updated requirements'; latest.acceptance = ['Revised acceptance'];
      if (snapshots.length === 3) { latest.status = 'completed'; }
      return Promise.resolve();
    });
    const loop = new GoalLoop({ read: () => Promise.resolve(latest), runTurn });
    const handle = loop.start('goal'); expect(loop.start('goal')).toBe(handle);
    expect(await handle.completion).toEqual({ reason: 'inactive', status: 'completed' });
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(snapshots[0]).toMatchObject({ revision: 1, objective: 'Initial requirements', acceptance: ['Initial acceptance'] });
    expect(snapshots.slice(1).map(s => s.revision)).toEqual([2, 3]);
    expect(snapshots[2].acceptance).toEqual(['Revised acceptance']);
  });
  it.each(['draft', 'paused', 'blocked', 'completed', 'abandoned'])('does not dispatch or poll when persistent state is %s', async status => {
    const read = vi.fn().mockResolvedValue({ ...active(), status }); const runTurn = vi.fn();
    const loop = new GoalLoop({ read, runTurn });
    expect(await loop.start('goal').completion).toEqual({ reason: 'inactive', status });
    expect(read).toHaveBeenCalledOnce(); expect(runTurn).not.toHaveBeenCalled();
  });
  it('holds one owner after stop until an uncooperative current turn actually settles', async () => {
    const task = gate(); const runTurn = vi.fn<GoalLoopPort<ReturnType<typeof active>>['runTurn']>(() => task.promise);
    const loop = new GoalLoop({ read: () => Promise.resolve(active()), runTurn }); const handle = loop.start('goal');
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce());
    handle.stop(); expect(loop.start('goal')).toBe(handle);
    let settled = false; void handle.completion.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    task.release(); task.release();
    expect(await handle.completion).toEqual({ reason: 'stopped' }); expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn.mock.calls[0][1].aborted).toBe(true);
  });
  it('does not dispatch after a pending read completes late following stop', async () => {
    const reading = gate(); const runTurn = vi.fn();
    const loop = new GoalLoop({ read: async () => { await reading.promise; return active(); }, runTurn });
    const handle = loop.start('goal'); handle.stop(); reading.release();
    expect(await handle.completion).toEqual({ reason: 'stopped' }); expect(runTurn).not.toHaveBeenCalled();
  });
  it('reports failed/unknown execution without resubmitting or classifying the goal as completed', async () => {
    const error = new Error('Owned executor result unknown'); const runTurn = vi.fn().mockRejectedValue(error);
    const read = vi.fn().mockResolvedValue(active()); const loop = new GoalLoop({ read, runTurn });
    expect(await loop.start('goal').completion).toEqual({ reason: 'failed', error });
    expect(read).toHaveBeenCalledOnce(); expect(runTurn).toHaveBeenCalledOnce();
  });
  it('observes a durable pause after the current turn and starts no further round', async () => {
    const latest = active(); const runTurn = vi.fn(() => { latest.status = 'paused'; latest.revision++; return Promise.resolve(); });
    const read = vi.fn(() => Promise.resolve(latest)); const loop = new GoalLoop({ read, runTurn });
    expect(await loop.start('goal').completion).toEqual({ reason: 'inactive', status: 'paused' });
    expect(read).toHaveBeenCalledTimes(2); expect(runTurn).toHaveBeenCalledOnce();
  });
  it('reports read failures or a missing record without executing or retrying', async () => {
    for (const read of [vi.fn().mockRejectedValue(new Error('storage unavailable')), vi.fn().mockResolvedValue(undefined)]) {
      const runTurn = vi.fn(); const loop = new GoalLoop({ read, runTurn });
      const outcome = await loop.start('goal').completion;
      expect(['failed', 'missing']).toContain(outcome.reason); expect(read).toHaveBeenCalledOnce(); expect(runTurn).not.toHaveBeenCalled();
    }
  });
  it('retains the settlement error if a cancelled native execution fails', async () => {
    const task = gate(); const error = new Error('cancel outcome unknown');
    const runTurn = vi.fn(async () => { await task.promise; throw error; });
    const loop = new GoalLoop({ read: () => Promise.resolve(active()), runTurn }); const handle = loop.start('goal');
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce()); handle.stop(); task.release();
    expect(await handle.completion).toEqual({ reason: 'stopped', error });
  });
  it('keeps separate goals independent and permits explicit fresh start after settlement', async () => {
    const task = gate(); const runTurn = vi.fn(() => task.promise);
    const loop = new GoalLoop({ read: id => Promise.resolve({ ...active(), id, status: id === 'blocked' ? 'blocked' : 'active' }), runTurn });
    const running = loop.start('goal'); const blocked = loop.start('blocked');
    expect(await blocked.completion).toEqual({ reason: 'inactive', status: 'blocked' });
    running.stop(); task.release(); await running.completion;
    const next = loop.start('goal'); expect(next).not.toBe(running); next.stop();
    expect(await next.completion).toEqual({ reason: 'stopped' });
  });
  it('rejects a mismatched loaded identity before any work is dispatched', async () => {
    const runTurn = vi.fn(); const loop = new GoalLoop({ read: () => Promise.resolve({ ...active(), id: 'other' }), runTurn });
    expect(await loop.start('goal').completion).toMatchObject({ reason: 'failed' }); expect(runTurn).not.toHaveBeenCalled();
  });
  it('yields between immediate turns so user cancellation can take effect', async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined); const loop = new GoalLoop({ read: () => Promise.resolve(active()), runTurn });
    const handle = loop.start('goal'); setImmediate(handle.stop);
    expect(await handle.completion).toEqual({ reason: 'stopped' }); expect(runTurn).toHaveBeenCalledOnce();
  });
});
