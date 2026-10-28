import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProjectArtifact, TaskReviewStore } from '@disclaude/core';
import { createTaskReviewReport, finalizeTaskReview } from './task-review-report.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const context = () => ({ signal: new AbortController().signal });
const proposal = { action: 'report', verdict: 'approved', reason: 'Read the actual report and checked the criterion', evidence: [{ criterion: 0, note: 'Exact content verified' }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-report-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'report.txt'), 'report\n');
  const store = new TaskReviewStore(join(root, 'reviews'), ref => readProjectArtifact(project, ref)), key = 'task-A';
  await store.create(key, ['Report has exact content'], randomUUID());
  const record = await store.submit(key, 1, { id: randomUUID(), submitter: randomUUID(), summary: 'Actual task output', refs: ['report.txt'] });
  const [target] = record.submissions;
  const authorize = vi.fn(), collection = createTaskReviewReport(target, authorize);
  return { root, store, key, record, target, authorize, collection };
}

it('shows a fixed submission and records only a detached proposal pending actual native outcome', async () => {
  const f = await fixture();
  const view = await f.collection.tool.execute({ action: 'get' }, context()) as { criteria: string[] };
  expect(view).toMatchObject({ submissionId: f.target.id, artifacts: f.target.artifacts }); view.criteria[0] = 'caller mutation';
  f.target.criteria[0] = 'later host mutation';
  expect(await f.collection.tool.execute({ action: 'get' }, context())).toMatchObject({ criteria: ['Report has exact content'] });
  expect(await f.collection.tool.execute(proposal, context())).toMatchObject({ recorded: true, nativeOutcomePending: true });
  const read = f.collection.read()!; read.reason = 'caller mutation'; expect(f.collection.read()!.reason).toBe(proposal.reason);
  expect((await f.store.get(f.key))?.revision).toBe(2);
});

it('commits under the actual reviewer identity only after physical execution settles', async () => {
  const f = await fixture(); await f.collection.tool.execute(proposal, context());
  const id = randomUUID(); let resolve!: (value: { id: string; outcome: string; truncated: boolean }) => void;
  const completion = new Promise<{ id: string; outcome: string; truncated: boolean }>(done => { resolve = done; });
  const commit = finalizeTaskReview({ ...f, expectedRevision: 2, handle: { id, completion } });
  await Promise.resolve(); expect((await f.store.get(f.key))?.revision).toBe(2);
  resolve({ id, outcome: 'succeeded', truncated: false });
  const approved = await commit; expect(approved.submissions[0].review).toMatchObject({ id, reviewer: id, verdict: 'approved' });
  expect(await f.store.verifyApproved(f.key, approved.revision)).toEqual(approved);
  await expect(f.collection.tool.execute(proposal, context())).rejects.toThrow('closed');
});

it.each([{ outcome: 'failed', truncated: false }, { outcome: 'stopped', truncated: false }, { outcome: 'succeeded', truncated: true }])(
  'ignores a proposal when native execution is incomplete (%j)', async status => {
    const f = await fixture(); await f.collection.tool.execute(proposal, context()); const id = randomUUID();
    await expect(finalizeTaskReview({ ...f, expectedRevision: 2, handle: { id, completion: Promise.resolve({ id, ...status }) } })).rejects.toThrow('native execution');
    expect((await f.store.get(f.key))?.revision).toBe(2);
  });

it('refuses missing proposal, mismatched native identity and self-review', async () => {
  const f = await fixture(), id = randomUUID();
  await expect(finalizeTaskReview({ ...f, expectedRevision: 2, handle: { id, completion: Promise.resolve({ id, outcome: 'succeeded', truncated: false }) } })).rejects.toThrow('no structured');
  const second = createTaskReviewReport(f.target, f.authorize); await second.tool.execute(proposal, context());
  await expect(finalizeTaskReview({ ...f, collection: second, expectedRevision: 2, handle: {
    id, completion: Promise.resolve({ id: randomUUID(), outcome: 'succeeded', truncated: false }),
  } })).rejects.toThrow('native execution');
  const third = createTaskReviewReport(f.target, f.authorize); await third.tool.execute(proposal, context());
  await expect(finalizeTaskReview({ ...f, collection: third, expectedRevision: 2, handle: {
    id: f.target.submitter, completion: Promise.resolve({ id: f.target.submitter, outcome: 'succeeded', truncated: false }),
  } })).rejects.toThrow('independent');
});

it('refuses owner/target injection, missing evidence and conflicting second proposals', async () => {
  const f = await fixture();
  for (const input of [{ ...proposal, reviewer: 'forged' }, { ...proposal, submissionId: randomUUID() },
    { ...proposal, reason: '' }, { ...proposal, evidence: [] },
    { ...proposal, evidence: [{ criterion: 1, note: 'wrong target' }] }]) {
    await expect(f.collection.tool.execute(input, context())).rejects.toThrow();
  }
  await f.collection.tool.execute(proposal, context()); await f.collection.tool.execute(proposal, context());
  await expect(f.collection.tool.execute({ ...proposal, verdict: 'changes-requested', evidence: [] }, context())).rejects.toThrow('already recorded');
});

it('checks current authorization/cancellation and rejects a revision changed during review', async () => {
  const f = await fixture();
  f.authorize.mockImplementationOnce(() => { throw new Error('permission revoked'); });
  await expect(f.collection.tool.execute({ action: 'get' }, context())).rejects.toThrow('revoked');
  const controller = new AbortController(); controller.abort();
  await expect(f.collection.tool.execute(proposal, { signal: controller.signal })).rejects.toThrow();
  await f.collection.tool.execute(proposal, context());
  await f.store.submit(f.key, 2, { id: randomUUID(), submitter: randomUUID(), summary: 'Newer submission', refs: ['report.txt'] });
  const id = randomUUID();
  await expect(finalizeTaskReview({ ...f, expectedRevision: 2, handle: { id, completion: Promise.resolve({ id, outcome: 'succeeded', truncated: false }) } })).rejects.toThrow('changed');
});

it('reconciles a lost persistence acknowledgement using the same actual handle and closed collection', async () => {
  const f = await fixture(); await f.collection.tool.execute(proposal, context()); const id = randomUUID();
  const handle = { id, completion: Promise.resolve({ id, outcome: 'succeeded', truncated: false }) };
  const review = f.store.review.bind(f.store);
  const saving = vi.spyOn(f.store, 'review').mockImplementationOnce(async (...args) => { await review(...args); throw new Error('lost persistence ACK'); });
  await expect(finalizeTaskReview({ ...f, expectedRevision: 2, handle })).rejects.toThrow('persistence ACK');
  const saved = await finalizeTaskReview({ ...f, expectedRevision: 2, handle });
  expect(saved.revision).toBe(3); expect(saved.submissions).toHaveLength(1); expect(saving.mock.calls[0]).toEqual(saving.mock.calls[1]);
});
