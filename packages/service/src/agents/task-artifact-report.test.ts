import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readProjectArtifact, TaskReviewStore } from '@disclaude/core';
import { createTaskArtifactReport, finalizeTaskSubmission } from './task-artifact-report.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const context = () => ({ signal: new AbortController().signal });
const proposal = { action: 'report', summary: 'Wrote and verified the report', refs: ['report.txt'] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-report-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'report.txt'), 'report\n');
  const store = new TaskReviewStore(join(root, 'reviews'), ref => readProjectArtifact(project, ref)), key = 'task-A';
  const criteria = ['Report has exact content']; await store.create(key, criteria, randomUUID());
  const authorize = vi.fn(), collection = createTaskArtifactReport(criteria, authorize);
  const id = randomUUID(), handle = { id, completion: Promise.resolve({ id, outcome: 'succeeded', truncated: false }) };
  return { root, project, store, key, criteria, authorize, collection, handle, expectedRevision: 1 };
}

it('freezes criteria and the proposal without saving or accepting native identity claims', async () => {
  const f = await fixture(); f.criteria[0] = 'changed';
  const shown = await f.collection.tool.execute({ action: 'get' }, context()) as { criteria: string[] };
  expect(shown.criteria).toEqual(['Report has exact content']); shown.criteria[0] = 'caller mutation';
  for (const input of [{ ...proposal, submitter: randomUUID() }, { ...proposal, sha256: 'forged' }, { ...proposal, refs: [] },
    { ...proposal, refs: ['report.txt', 'report.txt'] }, { ...proposal, summary: ' ' }]) {
    await expect(f.collection.tool.execute(input, context())).rejects.toThrow();
  }
  await f.collection.tool.execute(proposal, context()); await f.collection.tool.execute(proposal, context());
  const read = f.collection.read()!; read.refs[0] = 'changed'; expect(f.collection.read()!.refs).toEqual(['report.txt']);
  await expect(f.collection.tool.execute({ ...proposal, summary: 'conflict' }, context())).rejects.toThrow('already recorded');
  expect((await f.store.get(f.key))?.submissions).toEqual([]);
});

it('awaits actual settlement and reads current artifact bytes under the real native worker ID', async () => {
  const f = await fixture(); await f.collection.tool.execute(proposal, context());
  let done!: (value: { id: string; outcome: string; truncated: boolean }) => void;
  const completion = new Promise<{ id: string; outcome: string; truncated: boolean }>(resolve => { done = resolve; });
  const saved = finalizeTaskSubmission({ ...f, handle: { id: f.handle.id, completion } });
  await Promise.resolve(); expect((await f.store.get(f.key))?.revision).toBe(1);
  await writeFile(join(f.project, 'report.txt'), 'final settled bytes\n');
  done({ id: f.handle.id, outcome: 'succeeded', truncated: false });
  const record = await saved;
  expect(record.submissions[0]).toMatchObject({ id: f.handle.id, submitter: f.handle.id, summary: proposal.summary,
    artifacts: [{ ref: 'report.txt', bytes: 20, sha256: createHash('sha256').update('final settled bytes\n').digest('hex') }] });
  expect(record.submissions[0].review).toBeUndefined();
  await expect(f.collection.tool.execute(proposal, context())).rejects.toThrow('closed');
});

it.each([{ outcome: 'failed', truncated: false }, { outcome: 'stopped', truncated: false }, { outcome: 'succeeded', truncated: true }])(
  'does not submit partial/failed native work (%j)', async status => {
    const f = await fixture(); await f.collection.tool.execute(proposal, context());
    await expect(finalizeTaskSubmission({ ...f, handle: { id: f.handle.id,
      completion: Promise.resolve({ id: f.handle.id, ...status }) } })).rejects.toThrow('native execution');
    expect((await f.store.get(f.key))?.revision).toBe(1);
  });

it('refuses missing proposal, mismatched execution identity and unsafe artifact references', async () => {
  const f = await fixture(); await expect(finalizeTaskSubmission(f)).rejects.toThrow('no structured');
  const second = createTaskArtifactReport(f.criteria, f.authorize); await second.tool.execute(proposal, context());
  await expect(finalizeTaskSubmission({ ...f, collection: second, handle: { id: randomUUID(), completion: f.handle.completion } })).rejects.toThrow('native execution');
  const third = createTaskArtifactReport(f.criteria, f.authorize); await third.tool.execute({ ...proposal, refs: ['../outside.txt'] }, context());
  await expect(finalizeTaskSubmission({ ...f, collection: third })).rejects.toThrow();
  expect((await f.store.get(f.key))?.revision).toBe(1);
});

it('rechecks authorization and refuses stale criteria instead of overwriting them', async () => {
  const f = await fixture(); f.authorize.mockImplementationOnce(() => { throw new Error('revoked'); });
  await expect(f.collection.tool.execute(proposal, context())).rejects.toThrow('revoked');
  const abort = new AbortController(); abort.abort(); await expect(f.collection.tool.execute(proposal, { signal: abort.signal })).rejects.toThrow();
  await f.collection.tool.execute(proposal, context());
  f.authorize.mockImplementationOnce(() => { throw new Error('revoked'); });
  await expect(finalizeTaskSubmission(f)).rejects.toThrow('revoked');
  const next = createTaskArtifactReport(f.criteria, f.authorize); await next.tool.execute(proposal, context());
  await f.store.updateCriteria(f.key, 1, ['The updated requirement'], randomUUID());
  await expect(finalizeTaskSubmission({ ...f, collection: next })).rejects.toThrow('changed');
  expect((await f.store.get(f.key))?.submissions).toEqual([]);
});

it('reconciles a lost save acknowledgement from the same settled handle without native replay', async () => {
  const f = await fixture(); await f.collection.tool.execute(proposal, context());
  const submit = f.store.submit.bind(f.store);
  const saving = vi.spyOn(f.store, 'submit').mockImplementationOnce(async (...args) => { await submit(...args); throw new Error('lost save ACK'); });
  await expect(finalizeTaskSubmission(f)).rejects.toThrow('save ACK');
  const record = await finalizeTaskSubmission(f);
  expect(record.revision).toBe(2); expect(record.submissions).toHaveLength(1);
  expect(saving.mock.calls[0]).toEqual(saving.mock.calls[1]);
});
