import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskBoardProjection, type TaskBoardRecord } from './task-board-projection.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'board-projection-')); roots.push(root);
  const required = { task: 'task-A', goal: 'goal-A', criteria: 'Actual requirement' };
  const binding = { key: 'original-source/base/table/record/operation', recordId: 'actual-record', required, writable: ['owner', 'status'] };
  const record: TaskBoardRecord = { recordId: binding.recordId, fields: { ...required, owner: '', status: ['todo'], userNote: 'preserve user edits' } };
  const port = { read: vi.fn(() => Promise.resolve(structuredClone(record))), patch: vi.fn((fields: Record<string, unknown>) => {
    Object.assign(record.fields, fields); return Promise.resolve();
  }) };
  const authorize = vi.fn(), directory = join(root, 'intents');
  const create = () => new TaskBoardProjection(directory, binding, port, authorize);
  return { root, record, binding, port, authorize, create };
}
const desired = { owner: 'host-owner @ r1', status: ['running'] };

it('confirms actual fixed record cells and patches only the requested host fields', async () => {
  const f = await fixture(), projection = f.create();
  await projection.ensure(desired); await f.create().ensure(desired);
  expect(f.port.patch).toHaveBeenCalledExactlyOnceWith(desired); expect(f.record.fields.userNote).toBe('preserve user edits');
});

it('reconciles a committed write with a lost ACK after reconstruction without resending', async () => {
  const f = await fixture(); f.port.patch.mockImplementationOnce(fields => {
    Object.assign(f.record.fields, fields); return Promise.reject(new Error('lost remote ACK'));
  });
  await f.create().ensure(desired); await f.create().ensure(desired); expect(f.port.patch).toHaveBeenCalledOnce();
});

it('retains an unconfirmed write intent across restart and ignores object-key order on retry', async () => {
  const f = await fixture(); f.port.patch.mockRejectedValueOnce(new Error('unknown remote outcome'));
  await expect(f.create().ensure(desired)).rejects.toThrow('not confirmed');
  await expect(f.create().ensure({ status: desired.status, owner: desired.owner })).rejects.toThrow('no patch was resent');
  expect(f.port.patch).toHaveBeenCalledOnce();
  Object.assign(f.record.fields, desired); await f.create().ensure(desired); expect(f.port.patch).toHaveBeenCalledOnce();
});

it('does not overwrite changed identity/criteria or write arbitrary fields', async () => {
  const f = await fixture();
  await expect(f.create().ensure({ userNote: 'overwrite' })).rejects.toThrow('not writable');
  f.record.fields.criteria = 'New user criteria'; await expect(f.create().ensure(desired)).rejects.toThrow('changed');
  f.record.fields.criteria = f.binding.required.criteria; f.record.recordId = 'other-record';
  await expect(f.create().ensure(desired)).rejects.toThrow('changed'); expect(f.port.patch).not.toHaveBeenCalled();
});

it('rechecks current authority and blocks a late Goal/policy change before patch', async () => {
  const f = await fixture(); f.authorize.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('paused'); });
  await expect(f.create().ensure(desired)).rejects.toThrow('paused'); expect(f.port.patch).not.toHaveBeenCalled();
  f.authorize.mockReset(); await expect(f.create().ensure(desired)).rejects.toThrow('no patch was resent');
});

it('allows at most one patch across concurrent owners of the same durable intent', async () => {
  const f = await fixture();
  const result = await Promise.allSettled([f.create().ensure(desired), f.create().ensure(desired)]);
  expect(result.some(item => item.status === 'fulfilled')).toBe(true); expect(f.port.patch).toHaveBeenCalledOnce();
});
