import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskResultOutbox, type TaskCompletionReport } from './task-result-outbox.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'task-result-outbox-')); roots.push(root);
  const directory = join(root, 'private');
  const result: TaskCompletionReport = { id: randomUUID(), chatId: 'chat', actorId: 'actor', sourceMessageId: 'source',
    projectRoot: root, threadRootId: 'topic', outcome: 'succeeded', summary: 'Verified the file', artifacts: ['artifact.txt'] };
  return { root, directory, result, outbox: new TaskResultOutbox(directory) };
}
it('persists a settled result before delivery, keeping source, artifacts and private modes across restart', async () => {
  const { directory, result, outbox } = await fixture();
  const published = await outbox.publish(result); result.artifacts.push('mutated');
  const restored = new TaskResultOutbox(directory);
  expect(await restored.get(result.id)).toEqual(published);
  expect(await restored.listIds()).toEqual([result.id]);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(join(directory, `${result.id}.json`))).mode & 0o777).toBe(0o600);
});
it('publishes one immutable result and sends it once across duplicate completions and concurrent delivery', async () => {
  const { directory, result, outbox } = await fixture();
  await Promise.all([outbox.publish(result), new TaskResultOutbox(directory).publish({ ...result })]);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const send = vi.fn(async () => { entered(); await waiting; return 'actual-receipt'; });
  const first = outbox.deliver(result.id, send); await admitted;
  expect((await outbox.get(result.id))?.delivery).toBe('sending');
  const duplicate = new TaskResultOutbox(directory).deliver(result.id, send);
  release(); const [a, b] = await Promise.all([first, duplicate]);
  expect(a).toEqual(b); expect(send).toHaveBeenCalledTimes(1);
  expect(await outbox.publish(result)).toEqual(a);
  await expect(outbox.publish({ ...result, outcome: 'failed' })).rejects.toThrow('different work');
  expect((await outbox.get(result.id))?.receiptId).toBe('actual-receipt');
});
it.each(['failed', 'stopped'] as const)('keeps %s partial artifacts and does not re-execute any task', async outcome => {
  const { result, outbox } = await fixture();
  await outbox.publish({ ...result, outcome, summary: 'One known write remains; inspect it before further work' });
  const send = vi.fn(report => { expect(report.outcome).toBe(outcome); expect(report.artifacts).toEqual(['artifact.txt']); return Promise.resolve('receipt'); });
  await outbox.deliver(result.id, send); expect(send).toHaveBeenCalledTimes(1);
});
it.each(['throw', 'empty', 'echo'])('retains an uncertain %s acknowledgement without blind resend', async mode => {
  const { directory, result, outbox } = await fixture(); await outbox.publish(result);
  const send = vi.fn(() => mode === 'throw' ? Promise.reject(new Error('network reply lost')) : Promise.resolve(mode === 'empty' ? '' : result.id));
  await expect(outbox.deliver(result.id, send)).rejects.toThrow('not confirmed');
  const restored = new TaskResultOutbox(directory);
  expect((await restored.get(result.id))?.delivery).toBe('uncertain');
  await expect(restored.deliver(result.id, send)).rejects.toThrow('reconciliation');
  expect(send).toHaveBeenCalledTimes(1);
});
it('does not send when intent publication fails, and refuses replay after a sending intent survives restart', async () => {
  const { directory, result, outbox } = await fixture(); await outbox.publish(result);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); let fail = true;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === directory && fail) { fail = false; vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('intent sync failed')); }
    return handle;
  });
  const send = vi.fn(() => Promise.resolve('receipt'));
  await expect(outbox.deliver(result.id, send)).rejects.toThrow('intent sync failed');
  expect(send).not.toHaveBeenCalled(); expect((await outbox.get(result.id))?.delivery).toBe('sending');
  await expect(new TaskResultOutbox(directory).deliver(result.id, send)).rejects.toThrow('reconciliation');
});
it('preserves a delivered receipt when directory acknowledgement fails after publication', async () => {
  const { directory, result, outbox } = await fixture(); await outbox.publish(result);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); let syncs = 0;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === directory && ++syncs === 2) { vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('receipt sync failed')); }
    return handle;
  });
  const send = vi.fn(() => Promise.resolve('known-receipt'));
  await expect(outbox.deliver(result.id, send)).rejects.toThrow('receipt sync failed');
  expect((await outbox.deliver(result.id, send)).receiptId).toBe('known-receipt');
  expect(send).toHaveBeenCalledTimes(1);
});
it('preserves corrupt, redirected and oversized records instead of treating them as unsent', async () => {
  const { directory, result, outbox, root } = await fixture(); await outbox.publish(result);
  const file = join(directory, `${result.id}.json`);
  for (const content of ['{broken', 'x'.repeat(128 * 1024 + 1)]) {
    await fs.writeFile(file, content); await expect(outbox.deliver(result.id, () => Promise.resolve('receipt'))).rejects.toThrow('private storage');
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  }
  const other = join(root, 'untouched'); await fs.writeFile(other, 'retain'); await fs.unlink(file); await fs.symlink(other, file);
  await expect(outbox.get(result.id)).rejects.toThrow('private storage'); expect(await fs.readFile(other, 'utf8')).toBe('retain');
  const redirected = join(root, 'linked'); await fs.symlink(directory, redirected);
  await expect(new TaskResultOutbox(redirected).publish(result)).rejects.toThrow('real directory');
});
it('validates before creating storage and absent reads have no effects', async () => {
  const { directory, result, outbox } = await fixture();
  await expect(outbox.get(result.id)).resolves.toBeUndefined(); await expect(outbox.listIds()).resolves.toEqual([]);
  await expect(outbox.publish({ ...result, id: '../other' })).rejects.toThrow('Invalid');
  await expect(outbox.publish({ ...result, projectRoot: 'relative' })).rejects.toThrow('Invalid');
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
