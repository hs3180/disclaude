import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readProjectArtifact } from './project-artifact.js';
import { TaskReviewStore, type ReviewTaskSubmission, type TaskReviewRecord } from './task-review-store.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'task-review-')); roots.push(root);
  const project = join(root, 'project'), directory = join(root, 'reviews'); await fs.mkdir(project);
  const inspect = vi.fn((ref: string) => readProjectArtifact(project, ref));
  const store = new TaskReviewStore(directory, inspect), key = 'project/base/table/task-A';
  const initial = await store.create(key, ['Exact content is ready', 'A required section exists'], randomUUID());
  const file = join(project, 'report.txt'); await fs.writeFile(file, 'draft\n');
  const submit = (previous: TaskReviewRecord, extra = {}) => store.submit(key, previous.revision,
    { id: randomUUID(), submitter: 'actual-worker-A', summary: 'Actual artifact submitted', refs: ['report.txt'], ...extra });
  const decide = (previous: TaskReviewRecord, extra: Partial<ReviewTaskSubmission> = {}) => store.review(key, previous.revision,
    { id: randomUUID(), submissionId: previous.submissions.at(-1)!.id, reviewer: 'actual-reviewer-B', verdict: 'approved',
      reason: 'Both criteria checked against this submission', evidence: [{ criterion: 0, note: 'Exact bytes read' }, { criterion: 1, note: 'Section present in artifact' }], ...extra });
  return { root, project, directory, file, inspect, store, key, initial, submit, decide };
}

it('preserves rejection and rework history, then verifies the approved current bytes after reconstruction', async () => {
  const f = await fixture(), first = await f.submit(f.initial);
  const rejected = await f.decide(first, { verdict: 'changes-requested', reason: 'Required section missing', evidence: [] });
  await expect(f.store.verifyApproved(f.key, rejected.revision)).rejects.toThrow('no valid approval');
  await fs.writeFile(f.file, 'ready\nrequired section\n');
  const resubmitted = await f.submit(rejected), approved = await f.decide(resubmitted);
  expect(approved.revision).toBe(5); expect(approved.submissions).toHaveLength(2);
  expect(approved.submissions[0].review).toMatchObject({ verdict: 'changes-requested', reason: 'Required section missing' });
  expect(approved.submissions[1].artifacts[0].sha256).not.toBe(first.submissions[0].artifacts[0].sha256);
  const rebuilt = new TaskReviewStore(f.directory, f.inspect);
  expect(await rebuilt.verifyApproved(f.key, approved.revision)).toEqual(approved);
  expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o700);
  for (const name of await fs.readdir(f.directory)) { expect((await fs.stat(join(f.directory, name))).mode & 0o777).toBe(0o600); }
});

it('rejects missing/empty artifacts, self-approval and incomplete or empty acceptance evidence', async () => {
  const f = await fixture();
  expect(() => f.submit(f.initial, { refs: [] })).toThrow('Invalid');
  await expect(f.submit(f.initial, { refs: ['missing'] })).rejects.toThrow('Cannot verify');
  const submitted = await f.submit(f.initial);
  await expect(f.decide(submitted, { reviewer: 'actual-worker-A' })).rejects.toThrow('independent');
  await expect(f.decide(submitted, { evidence: [] })).rejects.toThrow('every acceptance');
  await expect(f.decide(submitted, { evidence: [{ criterion: 0, note: 'only one' }] })).rejects.toThrow('every acceptance');
  await expect(f.decide(submitted, { evidence: [{ criterion: 0, note: '' }] })).rejects.toThrow('evidence');
  await expect(f.decide(submitted, { evidence: [{ criterion: 0, note: 'a' }, { criterion: 0, note: 'duplicate' }] })).rejects.toThrow('evidence');
  expect(() => f.decide(submitted, { reason: '' })).toThrow('Invalid');
  expect((await f.store.get(f.key))?.revision).toBe(submitted.revision);
});

it('requires resubmission after observed byte changes and never reuses the previous approval', async () => {
  const f = await fixture(), submitted = await f.submit(f.initial);
  await fs.writeFile(f.file, 'changed before review');
  await expect(f.decide(submitted)).rejects.toThrow('Artifact changed');
  const newer = await f.submit(submitted), approved = await f.decide(newer);
  await fs.writeFile(f.file, 'changed after approval');
  await expect(f.store.verifyApproved(f.key, approved.revision)).rejects.toThrow('Artifact changed');
  const last = await f.submit(approved);
  await expect(f.store.verifyApproved(f.key, last.revision)).rejects.toThrow('no valid approval');
  expect(last.submissions.at(-1)!.review).toBeUndefined();
});

it('invalidates old approval after criteria change and retains the old requirements in history', async () => {
  const f = await fixture(), approved = await f.decide(await f.submit(f.initial));
  const edited = await f.store.updateCriteria(f.key, approved.revision, ['A new requirement'], randomUUID());
  await expect(f.store.verifyApproved(f.key, edited.revision)).rejects.toThrow('no valid approval');
  await expect(f.decide(edited)).rejects.toThrow('current submission');
  const next = await f.submit(edited), checked = await f.decide(next, { evidence: [{ criterion: 0, note: 'New requirement checked' }] });
  expect(checked.submissions[0].criteria).toEqual(f.initial.criteria); expect(checked.criteria).toEqual(['A new requirement']);
  expect(await f.store.verifyApproved(f.key, checked.revision)).toEqual(checked);
});

it('fences concurrent reviewers and a late review of an older submission', async () => {
  const f = await fixture(), submitted = await f.submit(f.initial);
  const outcomes = await Promise.allSettled([f.decide(submitted), f.decide(submitted)]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  const current = (await f.store.get(f.key))!, next = await f.submit(current);
  await expect(f.decide(next, { submissionId: submitted.submissions.at(-1)!.id })).rejects.toThrow('current submission');
  await expect(f.decide(submitted)).rejects.toThrow('changed'); expect((await f.store.get(f.key))?.revision).toBe(next.revision);
});

it('uses one canonical service queue through directory aliases', async () => {
  const f = await fixture(), alias = join(f.root, 'parent-alias'); await fs.symlink(f.root, alias);
  const second = new TaskReviewStore(join(alias, 'reviews'), f.inspect);
  const input = { id: randomUUID(), submitter: 'worker', summary: 'Submission', refs: ['report.txt'] };
  const outcomes = await Promise.allSettled([f.submit(f.initial), second.submit(f.key, f.initial.revision, input)]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect((await f.store.get(f.key))?.revision).toBe(2);
});

it('reconciles lost write acknowledgements with one operation and without rereading/reexecuting artifacts', async () => {
  const f = await fixture(), input = { id: randomUUID(), submitter: 'worker', summary: 'Submitted once', refs: ['report.txt'] };
  const { rename } = fs;
  const write = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => { await rename(from, to); throw new Error('lost write ACK'); });
  await expect(f.store.submit(f.key, 1, input)).rejects.toThrow('write ACK');
  write.mockRestore(); const reads = f.inspect.mock.calls.length;
  const result = await f.store.submit(f.key, 1, input); expect(result.revision).toBe(2); expect(f.inspect).toHaveBeenCalledTimes(reads);
  expect(result.submissions).toHaveLength(1);
  await expect(f.store.submit(f.key, 1, { ...input, summary: 'different command with same ID' })).rejects.toThrow('changed');
});

it('reconciles a directory-sync failure after publication and an uncertain review acknowledgement', async () => {
  const f = await fixture(), input = { id: randomUUID(), submitter: 'worker', summary: 'Published before sync failure', refs: ['report.txt'] };
  const { open, rename } = fs;
  const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.directory) { vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory sync failed after publication')); }
    return handle;
  });
  await expect(f.store.submit(f.key, 1, input)).rejects.toThrow('directory sync'); opening.mockRestore();
  const submitted = await f.store.submit(f.key, 1, input); expect(submitted.submissions).toHaveLength(1);
  const decision: ReviewTaskSubmission = { id: randomUUID(), submissionId: input.id, reviewer: 'reviewer', verdict: 'approved',
    reason: 'Checked exact submission', evidence: [{ criterion: 0, note: 'First checked' }, { criterion: 1, note: 'Second checked' }] };
  const writing = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('review ACK lost'); });
  await expect(f.store.review(f.key, 2, decision)).rejects.toThrow('review ACK'); writing.mockRestore();
  const reads = f.inspect.mock.calls.length, approved = await f.store.review(f.key, 2, decision);
  expect(approved.revision).toBe(3); expect(f.inspect).toHaveBeenCalledTimes(reads);
  expect(approved.submissions[0].review?.id).toBe(decision.id);
});

it('preserves the prior record on failed publication and fails closed on damaged or redirected storage', async () => {
  const f = await fixture(), names = await fs.readdir(f.directory), file = join(f.directory, names[0]), before = await fs.readFile(file);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected publication failure'));
  await expect(f.submit(f.initial)).rejects.toThrow('publication failure'); expect(await fs.readFile(file)).toEqual(before);
  await fs.writeFile(file, '{partial'); await expect(f.store.get(f.key)).rejects.toThrow('privately restore');
  await fs.rm(file); const outside = join(f.root, 'outside'); await fs.writeFile(outside, before); await fs.symlink(outside, file);
  await expect(f.store.get(f.key)).rejects.toThrow('privately restore'); expect(await fs.readFile(outside)).toEqual(before);
});

it('rejects forged stored approval evidence rather than treating malformed history as complete', async () => {
  const f = await fixture(), approved = await f.decide(await f.submit(f.initial));
  approved.submissions[0].review!.evidence = [];
  const [name] = await fs.readdir(f.directory); await fs.writeFile(join(f.directory, name), JSON.stringify(approved));
  await expect(f.store.get(f.key)).rejects.toThrow('privately restore');
});

it('detects a new revision admitted during artifact verification', async () => {
  const f = await fixture(), approved = await f.decide(await f.submit(f.initial));
  const original = f.inspect.getMockImplementation()!; let changed = false;
  f.inspect.mockImplementation(async ref => {
    const identity = await original(ref);
    if (!changed) { changed = true; await f.store.updateCriteria(f.key, approved.revision, ['Edited during check'], randomUUID()); }
    return identity;
  });
  await expect(f.store.verifyApproved(f.key, approved.revision)).rejects.toThrow('changed');
});

it('keeps detached caller snapshots and does not create absent storage on reads', async () => {
  const f = await fixture(), record = await f.store.get(f.key); record!.criteria[0] = 'caller mutation';
  expect((await f.store.get(f.key))!.criteria).toEqual(f.initial.criteria);
  const missing = join(f.root, 'missing'), empty = new TaskReviewStore(missing, f.inspect);
  expect(await empty.get('absent')).toBeUndefined(); await expect(fs.stat(missing)).rejects.toThrow();
});
