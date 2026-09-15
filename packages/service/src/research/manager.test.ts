import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, type ResearchStep, type StepResult, parseStepResult } from './project.js';
import { ResearchManager, type StepRunner } from './manager.js';

const managers: ResearchManager[] = [], directories: string[] = [];
afterEach(() => { managers.splice(0).forEach(m => m.dispose()); directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const input = { owner: 'alice', chat: 'chat-a', source: 'form-1', title: 'Compare the supplied reports', scope: 'Limit claims to the evidence', materials: 'Report A: cost 10; report B: cost 12.' };
const finding = { claim: 'Report A costs less', kind: 'fact' as const, sources: [{ title: 'Supplied reports', location: 'materials', excerpt: 'A: cost 10; B: cost 12' }], caveat: 'Costs may change' };
const result = (step: ResearchStep): StepResult => step.type === 'plan' ? { directions: ['Compare costs'] } : step.type === 'investigate' ? { findings: [finding] } : { summary: 'A costs less according to the supplied reports.', questions: ['Will costs change?'] };
function fixture(runner: StepRunner = (_p, step) => Promise.resolve(result(step)), publish = vi.fn(() => Promise.resolve('card-1')), directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'research-state-')); if (!directory) { directories.push(dir); }
  const manager = new ResearchManager(new ProjectStore(dir), runner, publish); managers.push(manager);
  return { manager, dir, publish };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('persistent research lifecycle', () => {
  it('creates one project for a repeated form and preserves its identity after restart', async () => {
    const { manager, dir } = fixture();
    const p = await manager.create(input);
    expect((await manager.create(input)).id).toBe(p.id);
    expect(manager.list('alice', 'chat-a')).toHaveLength(1);
    manager.dispose();
    const reopened = fixture(undefined, undefined, dir).manager;
    expect(reopened.get(p.id, 'alice', 'chat-a').title).toBe(input.title);
    expect(() => reopened.get(p.id, 'bob', 'chat-a')).toThrow('不属于');
    expect(() => reopened.get(p.id, 'alice', 'chat-b')).toThrow('不属于');
  });
  it('continues through planning, evidence and synthesis without more chat turns', async () => {
    const { manager } = fixture(); const p = await manager.create(input);
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(done.status).toBe('completed'); expect(done.directions[0].findings).toEqual([finding]);
    const successor = await manager.create({ ...input, source: 'continue-1', parent: p.id });
    expect(successor.id).not.toBe(p.id); expect(successor.parent).toBe(p.id);
    expect(successor.priorResults?.findings).toEqual([finding]);
    expect(manager.get(p.id, 'alice', 'chat-a').status).toBe('completed');
  });
  it('pauses at the in-flight phase boundary and resumes without repeating that phase', async () => {
    const entered = deferred<void>(), gate = deferred<StepResult>(); const steps: string[] = [];
    const { manager } = fixture((_p, step) => { steps.push(step.type); if (step.type === 'plan') { entered.resolve(); return gate.promise; } return Promise.resolve(result(step)); });
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await entered.promise;
    const running = manager.get(p.id, 'alice', 'chat-a'); await manager.act(p.id, 'alice', 'chat-a', running.revision, 'pause');
    expect(manager.get(p.id, 'alice', 'chat-a').status).toBe('pausing');
    gate.resolve({ directions: ['Compare costs'] }); await manager.idle(p.id);
    const paused = manager.get(p.id, 'alice', 'chat-a'); expect(paused.status).toBe('paused'); expect(steps).toEqual(['plan']);
    await manager.act(p.id, 'alice', 'chat-a', paused.revision, 'resume'); await manager.idle(p.id);
    expect(steps).toEqual(['plan', 'investigate', 'synthesize']);
  });
  it('cancels without accepting in-flight findings or starting another phase', async () => {
    const entered = deferred<void>(), gate = deferred<StepResult>(); const steps: string[] = [];
    const { manager } = fixture((_p, step) => { steps.push(step.type); if (step.type === 'investigate') { entered.resolve(); return gate.promise; } return Promise.resolve(result(step)); });
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await entered.promise;
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'cancel');
    gate.resolve({ findings: [finding] }); await manager.idle(p.id);
    const cancelled = manager.get(p.id, 'alice', 'chat-a'); expect(cancelled.status).toBe('cancelled');
    expect(cancelled.directions[0].findings).toEqual([]); expect(steps).toEqual(['plan', 'investigate']);
  });
  it('recovers interrupted state and keeps new feedback pending until a new plan accepts it', async () => {
    const entered = deferred<void>(), gate = deferred<StepResult>();
    const { manager, dir } = fixture(() => { entered.resolve(); return gate.promise; });
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await entered.promise;
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'feedback', 'Include report C');
    manager.dispose(); gate.resolve({ directions: ['Old plan'] }); await manager.idle(p.id);
    const reopened = fixture(undefined, undefined, dir).manager, recovered = reopened.get(p.id, 'alice', 'chat-a');
    expect(recovered.status).toBe('interrupted'); expect(recovered.feedback[0].status).toBe('pending');
    await reopened.act(p.id, 'alice', 'chat-a', recovered.revision, 'resume'); await reopened.idle(p.id);
    expect(reopened.get(p.id, 'alice', 'chat-a').feedback[0].status).toBe('applied');
  });
  it('keeps results when notification fails and refreshes without repeating research', async () => {
    let offline = false; const runner = vi.fn((_p, step: ResearchStep) => Promise.resolve(result(step)));
    const { manager } = fixture(runner, vi.fn(() => offline ? Promise.reject(new Error('offline')) : Promise.resolve('card-1')));
    const p = await manager.create(input); offline = true;
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    expect(manager.get(p.id, 'alice', 'chat-a').status).toBe('completed');
    expect(manager.get(p.id, 'alice', 'chat-a').deliveryError).toBeDefined(); offline = false;
    await manager.show(p.id, 'alice', 'chat-a'); expect(runner).toHaveBeenCalledTimes(3);
    expect(manager.get(p.id, 'alice', 'chat-a').deliveryError).toBeUndefined();
  });
  it('waits for clarification across restart and requires a new answer before resuming', async () => {
    const runner = vi.fn(() => Promise.resolve({ clarification: 'Which reporting period should be compared?' }));
    const { manager, dir } = fixture(runner);
    const p = await manager.create(input);
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'feedback', 'Compare costs');
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'resume');
    await manager.idle(p.id);
    const waiting = manager.get(p.id, 'alice', 'chat-a');
    expect(waiting.status).toBe('waiting-user'); expect(runner).toHaveBeenCalledTimes(1);
    manager.dispose();
    const reopened = fixture(undefined, undefined, dir).manager;
    expect(reopened.get(p.id, 'alice', 'chat-a').clarification).toContain('reporting period');
    await expect(reopened.act(p.id, 'alice', 'chat-a', waiting.revision, 'resume')).rejects.toThrow('补充信息');
    await reopened.act(p.id, 'alice', 'chat-a', waiting.revision, 'feedback', 'Use fiscal year 2025');
    const answered = reopened.get(p.id, 'alice', 'chat-a');
    expect(answered.status).toBe('waiting-user');
    await reopened.act(p.id, 'alice', 'chat-a', answered.revision, 'resume'); await reopened.idle(p.id);
    expect(reopened.get(p.id, 'alice', 'chat-a').status).toBe('completed');
    expect(reopened.get(p.id, 'alice', 'chat-a').clarification).toBeUndefined();
  });
  it('discards a stopped direction while letting the other direction finish', async () => {
    const entered = deferred<void>(), gate = deferred<StepResult>(); let calls = 0;
    const { manager } = fixture((_p, step) => {
      if (step.type === 'plan') { return Promise.resolve({ directions: ['Costs', 'Limitations'] }); }
      if (step.type === 'investigate' && calls++ === 0) { entered.resolve(); return gate.promise; }
      return Promise.resolve(result(step));
    });
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await entered.promise;
    const active = manager.get(p.id, 'alice', 'chat-a');
    await manager.act(p.id, 'alice', 'chat-a', active.revision, 'stop-direction', active.directions[0].id);
    gate.resolve({ findings: [finding] }); await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(done.status).toBe('completed'); expect(done.directions[0].status).toBe('stopped');
    expect(done.directions[0].findings).toEqual([]); expect(done.directions[1].status).toBe('done');
  });
  it('does not let a second live owner overwrite the same project store', async () => {
    const { manager, dir } = fixture(); await manager.create(input);
    const second = new ProjectStore(dir);
    expect(() => second.open()).toThrow('另一个服务');
    expect(existsSync(join(dir, '.recovering'))).toBe(false);
    manager.dispose(); second.open(); second.close();
  });
  it('recovers a provably exited owner while refusing an unfinished recovery', () => {
    const { dir } = fixture();
    const exitedPid = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(join(dir, '.owner'), exitedPid);
    writeFileSync(join(dir, '.recovering'), 'interrupted recovery');
    const store = new ProjectStore(dir);
    expect(() => store.open()).toThrow('恢复曾中断');
    rmSync(join(dir, '.recovering'));
    store.open(); store.close();
    expect(existsSync(join(dir, '.owner'))).toBe(false);
  });
  it('rejects facts with missing source fields', () => {
    expect(() => parseStepResult(JSON.stringify({ findings: [{ ...finding, sources: [] }] }), { type: 'investigate', directionId: 'd' })).toThrow('缺少来源');
  });
});
