import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, type ResearchProject, type Finding } from './project.js';
import { parseResearchCheckpoint, type ResearchCheckpoint } from '../research/checkpoint.js';
import type { DocumentReader, DocumentAppender } from './document-source.js';
import { ResearchManager, type ResearchRunner } from './manager.js';
import { researchDetailCard } from './cards.js';

// Scripted test agent: this particular fixture chooses three updates. The
// production manager no longer selects or knows these stages. Separate cases
// below exercise direct completion and arbitrary continued work.
type ResearchStep = { type: 'plan' } | { type: 'investigate'; directionId: string } | { type: 'synthesize' };
type Decision = { feedbackIndex: number; status: 'applied' | 'rejected'; reason: string; directionIndexes: number[] };
type StepResult = { clarification: string } | { directions: string[]; feedbackDecisions?: Decision[] } | { findings: Finding[] } | { summary: string; questions: string[] };
type StepRunner = (p: ResearchProject, step: ResearchStep, signal: AbortSignal) => Promise<StepResult>;
const managers: ResearchManager[] = [], directories: string[] = [];
afterEach(() => { managers.splice(0).forEach(m => m.dispose()); directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const input = { owner: 'alice', chat: 'chat-a', source: 'form-1', title: 'Compare the supplied reports', scope: 'Limit claims to the evidence', materials: 'Report A: cost 10; report B: cost 12.' };
const finding = { claim: 'Report A costs less', kind: 'fact' as const, sources: [{ title: 'Supplied reports', location: 'materials', excerpt: 'A: cost 10; B: cost 12' }], caveat: 'Costs may change' };
const result = (step: ResearchStep): StepResult => step.type === 'plan' ? { directions: ['Compare costs'] } : step.type === 'investigate' ? { findings: [finding] } : { summary: 'A costs less according to the supplied reports.', questions: ['Will costs change?'] };
function fixture(runner: StepRunner = (p, step) => Promise.resolve(step.type === 'plan' ? {
  directions: ['Compare costs'], feedbackDecisions: p.feedback.flatMap((f, feedbackIndex) =>
    f.status === 'pending' || f.status === 'needs-clarification' ? [{ feedbackIndex, status: 'applied' as const, reason: 'Compare the requested evidence in the cost direction.', directionIndexes: [0] }] : []),
} : result(step)), publish = vi.fn<(project: ResearchProject) => Promise<string>>(() => Promise.resolve('card-1')), directory?: string, readDocument?: DocumentReader, appendDocument?: DocumentAppender) {
  return checkpointFixture(async (p, signal) => {
    const direction = p.directions.find(d => d.status === 'pending');
    const step: ResearchStep = p.feedback.some(f => f.status === 'pending' || f.status === 'needs-clarification') || !p.directions.length
      ? { type: 'plan' } : direction ? { type: 'investigate', directionId: direction.id } : { type: 'synthesize' };
    const response = await runner(p, step, signal);
    const base = { message: 'Scripted task progress', work: [], feedback: [], questions: [] };
    if ('clarification' in response) { return { ...base, state: 'waiting-user', clarification: response.clarification }; }
    if ('directions' in response) {
      return { ...base, state: 'continue', work: [
        ...response.directions.map(title => ({ title, status: 'pending' as const, findings: [] })),
        ...p.directions.filter(d => d.status === 'pending').map(d => ({ ...d, status: 'stopped' as const })),
      ], feedback: (response.feedbackDecisions ?? []).map(d => ({ ...d, workIndexes: d.directionIndexes })) };
    }
    if ('findings' in response) { return { ...base, state: 'continue', work: [{ ...direction!, status: 'done', findings: response.findings }] }; }
    return { ...base, state: 'complete', ...response };
  }, publish, directory, readDocument, appendDocument);
}
function checkpointFixture(runner: ResearchRunner, publish = vi.fn<(project: ResearchProject) => Promise<string>>(() => Promise.resolve('card-1')), directory?: string, readDocument?: DocumentReader, appendDocument?: DocumentAppender) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'research-state-')); if (!directory) { directories.push(dir); }
  const manager = new ResearchManager(new ProjectStore(dir), runner, publish, readDocument, appendDocument); managers.push(manager);
  return { manager, dir, publish };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('persistent research lifecycle', () => {
  it('retains the original working directory across restart and continuation', async () => {
    const f = fixture();
    const original = await f.manager.create({ ...input, workingDir: '/projects/alpha' });
    await f.manager.act(original.id, 'alice', 'chat-a', original.revision, 'resume');
    await f.manager.idle(original.id);
    const completed = f.manager.get(original.id, 'alice', 'chat-a');
    f.manager.dispose();
    const reopened = fixture(undefined, undefined, f.dir).manager;
    expect(reopened.get(original.id, 'alice', 'chat-a').workingDir).toBe('/projects/alpha');
    const retry = await reopened.create({ ...input, workingDir: '/projects/beta' });
    expect(retry.id).toBe(original.id);
    expect(retry.workingDir).toBe('/projects/alpha');
    const successor = await reopened.create({ ...input, source: 'continuation', parent: original.id, workingDir: '/projects/beta' });
    expect(successor.workingDir).toBe('/projects/alpha');
    expect(reopened.get(original.id, 'alice', 'chat-a')).toEqual(completed);
    const fresh = await reopened.create({ ...input, source: 'new-form', workingDir: '/projects/beta' });
    expect(fresh.workingDir).toBe('/projects/beta');
    await expect(reopened.create({ ...input, source: 'bad-form', workingDir: 'relative' })).rejects.toThrow('绝对路径');
    const legacy = await reopened.create({ ...input, source: 'legacy' });
    await reopened.act(legacy.id, 'alice', 'chat-a', legacy.revision, 'cancel');
    const legacySuccessor = await reopened.create({ ...input, source: 'legacy-continuation', parent: legacy.id, workingDir: '/projects/beta' });
    expect(legacySuccessor.workingDir).toBeUndefined();
  });

  it('previews and confirms a reversible legacy project association without changing execution or findings', async () => {
    const f = fixture();
    const original = await f.manager.create(input);
    await f.manager.act(original.id, 'alice', 'chat-a', original.revision, 'resume');
    await f.manager.idle(original.id);
    const finished = f.manager.get(original.id, 'alice', 'chat-a');
    const preview = await f.manager.previewProjectLink(original.id, 'alice', 'chat-a', finished.revision, '/projects/alpha');
    expect(preview.projectLink).toBeUndefined();
    expect(preview.workingDir).toBeUndefined();
    expect(preview.directions).toEqual(finished.directions);
    await expect(f.manager.confirmProjectLink(original.id, 'other-user', 'chat-a', preview.revision, preview.linkPreview!.token, '/projects/alpha')).rejects.toThrow('不属于');
    await expect(f.manager.confirmProjectLink(original.id, 'alice', 'other-chat', preview.revision, preview.linkPreview!.token, '/projects/alpha')).rejects.toThrow('不属于');
    await expect(f.manager.confirmProjectLink(original.id, 'alice', 'chat-a', preview.revision, preview.linkPreview!.token, '/projects/beta')).rejects.toThrow('已改变');
    f.manager.dispose();
    const reopened = fixture(undefined, undefined, f.dir).manager;
    await reopened.confirmProjectLink(original.id, 'alice', 'chat-a', preview.revision, preview.linkPreview!.token, '/projects/alpha');
    const linked = reopened.get(original.id, 'alice', 'chat-a');
    expect(linked.projectLink?.directory).toBe('/projects/alpha');
    expect(linked.workingDir).toBeUndefined();
    expect(linked.summary).toBe(finished.summary);
    expect(linked.directions).toEqual(finished.directions);
    expect(linked.status).toBe('completed');
    await reopened.confirmProjectLink(original.id, 'alice', 'chat-a', preview.revision, preview.linkPreview!.token, '/projects/beta');
    expect(reopened.get(original.id, 'alice', 'chat-a')).toEqual(linked);
    const successor = await reopened.create({ ...input, source: 'linked-follow-up', parent: original.id });
    expect(successor.projectLink?.directory).toBe('/projects/alpha');
    expect(successor.projectLink?.token).not.toBe(linked.projectLink?.token);
    expect(successor.workingDir).toBeUndefined();
    await reopened.unlinkProject(original.id, 'alice', 'chat-a', linked.revision);
    const unlinked = reopened.get(original.id, 'alice', 'chat-a');
    expect(unlinked.projectLink).toBeUndefined();
    expect(reopened.get(successor.id, 'alice', 'chat-a').projectLink?.directory).toBe('/projects/alpha');
    expect(unlinked.summary).toBe(finished.summary);
    expect(unlinked.directions).toEqual(finished.directions);
    await expect(reopened.confirmProjectLink(original.id, 'alice', 'chat-a', preview.revision, preview.linkPreview!.token, '/projects/alpha')).rejects.toThrow('已改变');
    const fixed = await reopened.create({ ...input, source: 'fixed-directory', workingDir: '/projects/fixed' });
    await expect(reopened.previewProjectLink(fixed.id, 'alice', 'chat-a', fixed.revision, '/projects/alpha')).rejects.toThrow('固定项目目录');
  });

  it('refuses legacy association while a research stage is in flight', async () => {
    const pending = deferred<StepResult>();
    const f = fixture(() => pending.promise);
    const project = await f.manager.create(input);
    await f.manager.act(project.id, 'alice', 'chat-a', project.revision, 'resume');
    await expect(f.manager.previewProjectLink(project.id, 'alice', 'chat-a', f.manager.get(project.id, 'alice', 'chat-a').revision, '/projects/alpha')).rejects.toThrow('暂停任务');
    f.manager.dispose(); pending.resolve({ directions: ['Check evidence'] });
    await f.manager.idle(project.id);
  });

  function exportFixture() {
    const remote = { body: 'Supplied source\n', loseResponse: false, rejectWrite: false, concurrentEdit: false };
    const read: DocumentReader = (token, fragments = []) => {
      let { body } = remote;
      for (const fragment of fragments) { body = body.replace(`${fragment}\n`, ''); }
      return Promise.resolve({ token, revision: 3, body, rawBody: remote.body, comments: [], fingerprint: body, syncedAt: new Date().toISOString() });
    };
    const append = vi.fn<DocumentAppender>((_token, operation) => {
      if (remote.rejectWrite) { return Promise.reject(new Error('Connection lost before response')); }
      if (remote.concurrentEdit) { remote.body += 'User correction: include tax\n'; }
      remote.body += `${operation.paragraphs.join('\n')}\n`;
      return remote.loseResponse ? Promise.reject(new Error('Response lost after commit')) : Promise.resolve();
    });
    return { ...fixture(undefined, undefined, undefined, read, append), read, append, remote };
  }
  async function completedExportProject(f: ReturnType<typeof exportFixture>) {
    const p = await f.manager.create({ ...input, documentUrl: 'https://example.feishu.cn/docx/token' });
    await f.manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume');
    await f.manager.idle(p.id);
    return f.manager.get(p.id, 'alice', 'chat-a');
  }
  it('appends a completed result once and reconciles a lost response after restart', async () => {
    const f = exportFixture(); const p = await completedExportProject(f);
    f.remote.loseResponse = true;
    await f.manager.act(p.id, 'alice', 'chat-a', p.revision, 'export');
    const uncertain = f.manager.get(p.id, 'alice', 'chat-a');
    expect(uncertain.document?.export?.status).toBe('unknown');
    expect(uncertain.summary).toBe(p.summary);
    expect(f.remote.body).toContain('Supplied source');
    f.manager.dispose();
    const reopened = fixture(undefined, undefined, f.dir, f.read, f.append).manager;
    await reopened.act(p.id, 'alice', 'chat-a', uncertain.revision, 'export');
    const saved = reopened.get(p.id, 'alice', 'chat-a');
    expect(saved.document?.export?.status).toBe('saved');
    expect(saved.document?.snapshot?.body).toBe('Supplied source\n');
    await reopened.act(p.id, 'alice', 'chat-a', saved.revision, 'export');
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(saved.stepCount).toBe(p.stepCount);
  });
  it('refuses to append over new feedback and retains the completed result', async () => {
    const f = exportFixture(); const p = await completedExportProject(f);
    f.remote.body += 'New user scope\n';
    await f.manager.act(p.id, 'alice', 'chat-a', p.revision, 'export');
    expect(f.append).not.toHaveBeenCalled();
    const conflict = f.manager.get(p.id, 'alice', 'chat-a');
    expect(conflict.document?.export?.status).toBe('conflict');
    expect(conflict.summary).toBe(p.summary);
    expect(f.remote.body).toBe('Supplied source\nNew user scope\n');
  });
  it('preserves concurrent edits and carries them into a follow-up without self-feedback', async () => {
    const f = exportFixture(); const p = await completedExportProject(f);
    f.remote.concurrentEdit = true;
    await f.manager.act(p.id, 'alice', 'chat-a', p.revision, 'export');
    const conflict = f.manager.get(p.id, 'alice', 'chat-a');
    expect(conflict.document?.export?.status).toBe('conflict');
    expect(conflict.document?.publishedFragments).toHaveLength(1);
    expect(f.remote.body).toContain('User correction: include tax');
    await f.manager.act(p.id, 'alice', 'chat-a', conflict.revision, 'export');
    expect(f.append).toHaveBeenCalledTimes(1);
    const next = await f.manager.create({ ...input, source: 'follow-up', parent: p.id, documentUrl: 'https://example.feishu.cn/docx/token' });
    await f.manager.act(next.id, 'alice', 'chat-a', next.revision, 'resume'); await f.manager.idle(next.id);
    const body = f.manager.get(next.id, 'alice', 'chat-a').document?.snapshot?.body;
    expect(body).toContain('User correction: include tax');
    expect(body).not.toContain('任务成果快照');
  });
  it('does not repeat an ambiguous write when reconciliation cannot find its fragment', async () => {
    const f = exportFixture(); const p = await completedExportProject(f);
    f.remote.rejectWrite = true;
    await f.manager.act(p.id, 'alice', 'chat-a', p.revision, 'export');
    const uncertain = f.manager.get(p.id, 'alice', 'chat-a');
    await f.manager.act(p.id, 'alice', 'chat-a', uncertain.revision, 'export');
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.manager.get(p.id, 'alice', 'chat-a').document?.export?.status).toBe('unknown');
    expect(f.remote.body).toBe('Supplied source\n');
  });
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
    expect(done.questions).toEqual(['Will costs change?']);
    const successor = await manager.create({ ...input, source: 'continue-1', parent: p.id });
    expect(successor.id).not.toBe(p.id); expect(successor.parent).toBe(p.id);
    expect(successor.priorResults?.findings).toEqual([finding]);
    expect(manager.get(p.id, 'alice', 'chat-a').status).toBe('completed');
  });
  it('continues a selected finding with its sources after restart without changing the original', async () => {
    const second = { ...finding, claim: 'Report B costs 12', caveat: 'Tax is unknown' };
    const { manager, dir } = fixture((_p, step) => Promise.resolve(step.type === 'investigate' ? { findings: [finding, second] } : result(step)));
    const p = await manager.create(input);
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const original = manager.get(p.id, 'alice', 'chat-a');
    const parentFinding = { directionId: original.directions[0].id, index: 1 };
    const request = { ...input, source: 'selected-finding', parent: p.id, parentFinding };
    const next = await manager.create(request);
    expect(next.status).toBe('paused'); expect(next.title).toContain(second.claim);
    expect(next.scope).toContain(second.claim); expect(next.scope).not.toBe(original.scope);
    expect(next.priorResults?.scope).toBe(original.scope);
    expect(next.priorResults?.findings).toEqual([second]);
    expect(next.parentFinding).toEqual(parentFinding);
    expect(manager.get(p.id, 'alice', 'chat-a')).toEqual(original);
    manager.dispose();
    const reopened = fixture(undefined, undefined, dir).manager;
    expect((await reopened.create(request)).id).toBe(next.id);
    expect(reopened.get(next.id, 'alice', 'chat-a').priorResults?.findings).toEqual([second]);
    for (const index of [-1, 2, 0.5]) {
      await expect(reopened.create({ ...request, source: `invalid-${index}`, parentFinding: { ...parentFinding, index } })).rejects.toThrow('所选发现不存在');
    }
    await expect(reopened.create({ ...request, source: 'wrong-owner', owner: 'bob' })).rejects.toThrow('不属于');
    expect(reopened.list('alice', 'chat-a')).toHaveLength(2);
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
  it('does not offer continuation during cancellation or recovery after a cancelled turn fails', async () => {
    const entered = deferred<void>(), gate = deferred<ResearchCheckpoint>();
    const { manager } = checkpointFixture(() => { entered.resolve(); return gate.promise; });
    const p = await manager.create(input);
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await entered.promise;
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'cancel');
    const pending = manager.get(p.id, 'alice', 'chat-a');
    const pendingCard = JSON.stringify(researchDetailCard(pending));
    gate.resolve({ state: 'complete', message: 'Invalid late result', work: [], feedback: [], questions: [] } as unknown as ResearchCheckpoint);
    await manager.idle(p.id);
    const cancelled = manager.get(p.id, 'alice', 'chat-a');
    expect(pending.status).toBe('cancelling');
    expect(pendingCard).not.toContain('基于成果继续任务');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBeUndefined();
    expect(cancelled.history.at(-1)?.text).toContain('已取消');
    expect(JSON.stringify(researchDetailCard(cancelled))).not.toContain('恢复重试');
    expect(JSON.stringify(researchDetailCard(cancelled))).toContain('基于成果继续任务');
    expect(cancelled.directions).toEqual([]); expect(cancelled.summary).toBe('');
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
  it('requires explicit feedback decisions and retains actual plan links across restart', async () => {
    let complete = false;
    const { manager, dir } = fixture((_p, step) => Promise.resolve(step.type === 'plan' ? {
      directions: ['Compare taxes'], feedbackDecisions: complete ? [
        { feedbackIndex: 0, status: 'applied', reason: 'Tax changes the comparable total.', directionIndexes: [0] },
        { feedbackIndex: 1, status: 'rejected', reason: 'Weather is outside the price comparison scope.', directionIndexes: [] },
      ] : [],
    } : result(step)));
    const p = await manager.create(input);
    for (const feedback of ['Include taxes', 'Predict the weather']) {
      await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'feedback', feedback);
    }
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'resume'); await manager.idle(p.id);
    const failed = manager.get(p.id, 'alice', 'chat-a');
    expect(failed.status).toBe('failed'); expect(failed.directions).toEqual([]);
    expect(failed.feedback.map(f => f.status)).toEqual(['pending', 'pending']);
    complete = true;
    await manager.act(p.id, 'alice', 'chat-a', failed.revision, 'resume'); await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(done.feedback[0].directionIds).toEqual([done.directions[0].id]);
    expect(done.feedback[1]).toMatchObject({ status: 'rejected', directionIds: [], reason: 'Weather is outside the price comparison scope.' });
    manager.dispose();
    expect(fixture(undefined, undefined, dir).manager.get(p.id, 'alice', 'chat-a').feedback).toEqual(done.feedback);
  });

  it('retains the last document snapshot and pending feedback when a phase-boundary read fails', async () => {
    const snapshot = { token: 'ABC123', revision: 1, body: 'Include taxes', comments: [], fingerprint: 'one', syncedAt: new Date().toISOString() };
    const readDocument = vi.fn().mockResolvedValue(snapshot);
    readDocument.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('comment page unavailable'));
    const { manager } = fixture(undefined, undefined, undefined, readDocument);
    const p = await manager.create({ ...input, documentUrl: 'https://example.feishu.cn/docx/ABC123' });
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const failed = manager.get(p.id, 'alice', 'chat-a');
    expect(failed.status).toBe('failed');
    expect(failed.document?.snapshot?.body).toBe('Include taxes');
    expect(failed.document?.error).toContain('未同步');
    expect(failed.feedback[0].status).toBe('pending');
    expect(failed.directions).toEqual([]);
    await manager.act(p.id, 'alice', 'chat-a', failed.revision, 'resume'); await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(done.status).toBe('completed');
    expect(done.document?.error).toBeUndefined();
    expect(done.feedback).toHaveLength(1);
    expect(done.feedback[0].status).toBe('applied');
  });
  it('replans when the document changes during synthesis and retains the earlier body', async () => {
    let snapshot = { token: 'ABC123', revision: 1, body: 'Compare prices', comments: [], fingerprint: 'one', syncedAt: new Date().toISOString() };
    let syntheses = 0;
    const runner: StepRunner = (p, step) => {
      if (step.type === 'plan') {
        return Promise.resolve({ directions: ['Compare costs'], feedbackDecisions: p.feedback.flatMap((f, feedbackIndex) => f.status === 'pending'
          ? [{ feedbackIndex, status: 'applied' as const, reason: 'Use the latest document scope.', directionIndexes: [0] }] : []) });
      }
      if (step.type === 'synthesize' && syntheses++ === 0) { snapshot = { ...snapshot, revision: 2, body: 'Include taxes', fingerprint: 'two' }; }
      return Promise.resolve(result(step));
    };
    const { manager } = fixture(runner, undefined, undefined, () => Promise.resolve(snapshot));
    const p = await manager.create({ ...input, documentUrl: 'https://example.feishu.cn/docx/ABC123' });
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(syntheses).toBe(2); expect(done.status).toBe('completed');
    expect(done.document?.previous.map(s => s.body)).toEqual(['Compare prices']);
    expect(done.document?.snapshot?.body).toBe('Include taxes');
    expect(done.feedback).toHaveLength(2);
    expect(done.feedback.every(f => f.status === 'applied')).toBe(true);
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
    expect(waiting.feedback[0].status).toBe('needs-clarification');
    expect(waiting.feedback[0].reason).toContain('reporting period');
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
  it('syncs a document answer before resuming a waiting task after restart', async () => {
    const snapshot = { token: 'ABC123', revision: 1, body: 'Compare costs', comments: [] as Array<{ id: string; text: string }>, fingerprint: 'one', syncedAt: new Date().toISOString() };
    const readDocument = vi.fn().mockResolvedValue(snapshot);
    const waitingRunner = vi.fn(() => Promise.resolve({ clarification: 'Which reporting period?' }));
    const { manager, dir } = fixture(waitingRunner, undefined, undefined, readDocument);
    const p = await manager.create({ ...input, documentUrl: 'https://example.feishu.cn/docx/ABC123' });
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    manager.dispose();
    const { manager: reopened, publish } = fixture(undefined, undefined, dir, readDocument);
    const waiting = reopened.get(p.id, 'alice', 'chat-a');
    await expect(reopened.act(p.id, 'alice', 'chat-a', waiting.revision, 'resume')).rejects.toThrow('补充信息');
    expect(reopened.get(p.id, 'alice', 'chat-a').status).toBe('waiting-user');
    const unchanged = reopened.get(p.id, 'alice', 'chat-a');
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ revision: unchanged.revision, status: 'waiting-user' }));
    readDocument.mockRejectedValueOnce(new Error('Comment service unavailable'));
    await expect(reopened.act(p.id, 'alice', 'chat-a', unchanged.revision, 'resume')).rejects.toThrow('Document sync failed');
    expect(reopened.get(p.id, 'alice', 'chat-a')).toMatchObject({ status: 'waiting-user', document: { error: expect.stringContaining('未同步') } });
    readDocument.mockResolvedValue({ ...snapshot, revision: 2, fingerprint: 'two', comments: [{ id: 'answer', text: 'Use fiscal year 2025' }] });
    const current = reopened.get(p.id, 'alice', 'chat-a');
    await reopened.act(p.id, 'alice', 'chat-a', current.revision, 'resume'); await reopened.idle(p.id);
    const completed = reopened.get(p.id, 'alice', 'chat-a');
    expect(publish).toHaveBeenCalled();
    expect(completed.status).toBe('completed');
    expect(completed.feedback.find(f => f.sourceKey?.includes(':comment:answer:'))).toMatchObject({ status: 'applied', text: 'Use fiscal year 2025' });
  });

  it.each(['cancel', 'dispose'] as const)('does not resume after %s while syncing a document answer', async action => {
    const snapshot = { token: 'ABC123', revision: 1, body: 'Compare costs', comments: [] as Array<{ id: string; text: string }>, fingerprint: 'one', syncedAt: new Date().toISOString() };
    const readDocument = vi.fn().mockResolvedValue(snapshot);
    const runner = vi.fn(() => Promise.resolve({ clarification: 'Which reporting period?' }));
    const { manager } = fixture(runner, undefined, undefined, readDocument);
    const p = await manager.create({ ...input, documentUrl: 'https://example.feishu.cn/docx/ABC123' });
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const gate = deferred<typeof snapshot>(), entered = deferred<void>();
    readDocument.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const waiting = manager.get(p.id, 'alice', 'chat-a');
    const resuming = manager.act(p.id, 'alice', 'chat-a', waiting.revision, 'resume');
    const rejected = expect(resuming).rejects.toThrow();
    await entered.promise;
    if (action === 'cancel') { await manager.act(p.id, 'alice', 'chat-a', waiting.revision, 'cancel'); }
    else { manager.dispose(); }
    gate.resolve({ ...snapshot, revision: 2, fingerprint: 'two', comments: [{ id: 'answer', text: 'Use fiscal year 2025' }] });
    await rejected;
    expect(runner).toHaveBeenCalledTimes(1);
    if (action === 'cancel') { expect(manager.get(p.id, 'alice', 'chat-a').status).toBe('cancelled'); }
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
  it('archives only finished projects and restores their identity and evidence after restart', async () => {
    const { manager, dir } = fixture(); const p = await manager.create(input);
    await expect(manager.act(p.id, 'alice', 'chat-a', p.revision, 'archive')).rejects.toThrow('先结束');
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const completed = manager.get(p.id, 'alice', 'chat-a');
    await manager.act(p.id, 'alice', 'chat-a', completed.revision, 'archive');
    expect(manager.list('alice', 'chat-a')).toEqual([]);
    expect(manager.list('alice', 'chat-a', true).map(p => p.id)).toEqual([p.id]);
    expect(manager.list('bob', 'chat-a', true)).toEqual([]);
    manager.dispose();
    const reopened = fixture(undefined, undefined, dir).manager;
    const archived = reopened.get(p.id, 'alice', 'chat-a');
    expect(archived.summary).toBe(completed.summary); expect(archived.directions).toEqual(completed.directions);
    await reopened.act(p.id, 'alice', 'chat-a', archived.revision, 'unarchive');
    expect(reopened.list('alice', 'chat-a').map(p => p.id)).toEqual([p.id]);
    expect(reopened.list('alice', 'chat-a', true)).toEqual([]);
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
  it('allows evidence and completion in one turn without a mandatory plan or synthesis turn', async () => {
    const runner = vi.fn<ResearchRunner>(() => Promise.resolve({ state: 'complete', message: 'Verified supplied costs',
      work: [{ title: 'Cost check', status: 'done', findings: [finding] }], feedback: [], summary: 'A costs less.', questions: [] }));
    const { manager } = checkpointFixture(runner);
    const p = await manager.create(input);
    await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(done.status).toBe('completed'); expect(done.stepCount).toBe(1);
    expect(done.directions[0].findings).toEqual([finding]);
  });

  it('persists ordinary task work through a question, restart and new feedback without a research-stage contract', async () => {
    let calls = 0;
    const first = checkpointFixture(() => Promise.resolve(++calls === 1
      ? { state: 'continue', message: 'Located missing build input', work: [{ title: 'Diagnose build', status: 'done', findings: [] }], feedback: [], questions: [] }
      : { state: 'waiting-user', message: 'Need input location', clarification: 'Which catalog should the build use?', work: [], feedback: [], questions: [] }));
    const p = await first.manager.create({ ...input, title: 'Diagnose and explain a build failure' });
    await first.manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await first.manager.idle(p.id);
    const waiting = first.manager.get(p.id, 'alice', 'chat-a');
    expect(waiting.status).toBe('waiting-user'); expect(calls).toBe(2);
    first.manager.dispose();
    const resumed = checkpointFixture(snapshot => {
      expect(snapshot.directions).toEqual(waiting.directions);
      expect(snapshot.feedback[0].text).toBe('Use catalog-2026.csv');
      return Promise.resolve({ state: 'complete', message: 'Explained required input', work: [{ title: 'Resolve build input', status: 'done', findings: [] }],
        feedback: [{ feedbackIndex: 0, status: 'applied', reason: 'The requested catalog is named in the resolution.', workIndexes: [0] }], summary: 'Supply catalog-2026.csv to the build.', questions: [] });
    }, undefined, first.dir).manager;
    await resumed.act(p.id, 'alice', 'chat-a', waiting.revision, 'feedback', 'Use catalog-2026.csv');
    await resumed.act(p.id, 'alice', 'chat-a', resumed.get(p.id, 'alice', 'chat-a').revision, 'resume'); await resumed.idle(p.id);
    const done = resumed.get(p.id, 'alice', 'chat-a');
    expect(done.status).toBe('completed'); expect(done.directions).toHaveLength(2);
    expect(done.directions[0]).toEqual(waiting.directions[0]);
    expect(done.feedback[0].directionIds).toEqual([done.directions[1].id]);
  });

  it('retains checkpoint evidence but does not complete over feedback arriving during the turn', async () => {
    const entered = deferred<void>(), gate = deferred<ResearchCheckpoint>(); let calls = 0;
    const { manager } = checkpointFixture(snapshot => {
      if (++calls === 1) { entered.resolve(); return gate.promise; }
      expect(snapshot.directions[0].findings).toEqual([finding]);
      expect(snapshot.feedback[0].status).toBe('pending');
      return Promise.resolve({ state: 'complete', message: 'Checked correction', work: [{ title: 'Tax check', status: 'done', findings: [] }],
        feedback: [{ feedbackIndex: 0, status: 'applied', reason: 'Correction addressed by tax check.', workIndexes: [0] }], summary: 'Corrected result', questions: [] });
    });
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await entered.promise;
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'feedback', 'Include tax');
    gate.resolve({ state: 'complete', message: 'Original check', work: [{ title: 'Costs', status: 'done', findings: [finding] }], feedback: [], summary: 'Stale result', questions: [] });
    await manager.idle(p.id);
    const done = manager.get(p.id, 'alice', 'chat-a');
    expect(calls).toBe(2); expect(done.summary).toBe('Corrected result');
    expect(done.directions[0].findings).toEqual([finding]);
  });

  it('rejects a whole invalid checkpoint without partially committing work or feedback', async () => {
    const { manager } = checkpointFixture(() => Promise.resolve({ state: 'continue', message: 'Invalid update',
      work: [{ title: 'Valid addition', status: 'done', findings: [finding] }, { id: 'missing', title: 'Bad update', status: 'done', findings: [] }],
      feedback: [{ feedbackIndex: 0, status: 'applied', reason: 'Applied', workIndexes: [0] }], questions: [] }));
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'feedback', 'Check costs');
    await manager.act(p.id, 'alice', 'chat-a', manager.get(p.id, 'alice', 'chat-a').revision, 'resume'); await manager.idle(p.id);
    const failed = manager.get(p.id, 'alice', 'chat-a');
    expect(failed.status).toBe('failed'); expect(failed.directions).toEqual([]); expect(failed.feedback[0].status).toBe('pending');
  });

  it.each(['completed', 'waiting-user', 'failed', 'paused'] as const)(
    'preserves committed %s state when shutdown races final card delivery', async status => {
      const entered = deferred<void>(), delivery = deferred<string>();
      let started = false;
      const publish = vi.fn((project: ResearchProject) => {
        if (started && project.status === status) { entered.resolve(); return delivery.promise; }
        return Promise.resolve('card-1');
      });
      const runner: ResearchRunner = () => {
        if (status === 'failed') { return Promise.reject(new Error('Task failed')); }
        return Promise.resolve({ state: status === 'completed' ? 'complete' : status === 'waiting-user' ? 'waiting-user' : 'continue',
          message: 'Progress retained', work: [], feedback: [], questions: [],
          ...(status === 'completed' ? { summary: 'Completed result' } : {}),
          ...(status === 'waiting-user' ? { clarification: 'Choose A or B' } : {}),
        });
      };
      const { manager, dir } = checkpointFixture(runner, publish);
      const p = await manager.create(input); started = true;
      await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume');
      await entered.promise;
      const committed = manager.get(p.id, 'alice', 'chat-a');
      manager.dispose();
      delivery.resolve('late-card'); await manager.idle(p.id);
      const reopened = checkpointFixture(runner, undefined, dir).manager;
      expect(reopened.get(p.id, 'alice', 'chat-a')).toEqual(committed);
    },
  );

  it('retains source-backed evidence when the model omits an empty caveat', () => {
    const parse = (caveat: unknown) => parseResearchCheckpoint(JSON.stringify({
      state: 'complete', message: 'Wait completed', summary: 'Reported value 23',
      work: [{ title: 'Bounded wait', status: 'done', findings: [{ ...finding, caveat }] }],
    }));
    expect(parse(undefined).work[0].findings[0]).toEqual({ ...finding, caveat: '' });
    expect(parse('').work[0].findings[0].caveat).toBe('');
    expect(parse('Unverified fictional value').work[0].findings[0].caveat).toBe('Unverified fictional value');
    for (const invalid of [null, 42, {}, 'x'.repeat(501)]) {
      expect(() => parse(invalid)).toThrow('Invalid task checkpoint text');
    }
  });

  it('pauses on the turn budget without fabricating completion or a final result', async () => {
    const runner = vi.fn<ResearchRunner>(() => Promise.resolve({ state: 'continue', message: 'Still working', work: [], feedback: [], questions: [] }));
    const { manager } = checkpointFixture(runner);
    const p = await manager.create(input); await manager.act(p.id, 'alice', 'chat-a', p.revision, 'resume'); await manager.idle(p.id);
    const paused = manager.get(p.id, 'alice', 'chat-a');
    expect(paused.status).toBe('paused'); expect(paused.summary).toBe(''); expect(runner).toHaveBeenCalledTimes(12);
  });

  it('rejects facts with missing source fields', () => {
    expect(() => parseResearchCheckpoint(JSON.stringify({ state: 'continue', message: 'Evidence', work: [{ title: 'Costs', status: 'done', findings: [{ ...finding, sources: [] }] }] }))).toThrow('requires sources');
  });
  it('does not treat a null clarification as waiting, but requires a question when waiting', () => {
    expect(parseResearchCheckpoint('{"state":"continue","message":"Progress","clarification":null}').state).toBe('continue');
    expect(() => parseResearchCheckpoint('{"state":"waiting-user","message":"Progress","clarification":null}')).toThrow('requires a question');
  });
  it('rejects feedback receipts without an actual work reference or rejection reason', () => {
    const decision = { feedbackIndex: 0, status: 'applied', reason: 'Compare after-tax totals.', workIndexes: [0] };
    const parse = (receipt: Record<string, unknown>) => parseResearchCheckpoint(JSON.stringify({ state: 'continue', message: 'Progress', work: [{ title: 'Taxes', status: 'pending' }], feedback: [receipt] }));
    expect(() => parse({ ...decision, workIndexes: [] })).toThrow('actual work');
    expect(() => parse({ ...decision, workIndexes: [1] })).toThrow('reference');
    expect(() => parse({ ...decision, status: 'rejected', workIndexes: [], reason: '' })).toThrow('text');
    expect(parse(decision)).toMatchObject({ feedback: [decision] });
  });
});
