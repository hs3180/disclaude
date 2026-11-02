import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSingleTaskReport, readTaskReports, writeTaskReport } from './task-report-inbox.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });
const inbox = (): string => { const root = mkdtempSync(join(tmpdir(), 'task-report-')); roots.push(root); return join(root, 'op-1'); };

describe('writeTaskReport', () => {
  it('accepts a valid artifacts proposal and reads it back normalized', async () => {
    const dir = inbox();
    const name = await writeTaskReport(dir, 'artifacts', { summary: 'Read back report.txt', refs: ['b.md', 'a.md'] });
    expect(name).toMatch(/^receipt-[0-9a-f]{64}\.json$/);
    const receipts = await readTaskReports(dir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe('artifacts');
    expect(receipts[0].payload).toEqual({ summary: 'Read back report.txt', refs: ['a.md', 'b.md'] });
  });

  it('accepts a review proposal and keeps evidence sorted by criterion', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'review', { verdict: 'approved', reason: 'Checked every criterion',
      evidence: [{ criterion: 1, note: 'second' }, { criterion: 0, note: 'first' }] });
    const [receipt] = await readTaskReports(dir);
    expect(receipt.payload).toEqual({ verdict: 'approved', reason: 'Checked every criterion',
      evidence: [{ criterion: 0, note: 'first' }, { criterion: 1, note: 'second' }] });
  });

  it('redelivering the identical payload is idempotent', async () => {
    const dir = inbox();
    const first = await writeTaskReport(dir, 'artifacts', { summary: 'same', refs: ['a.txt'] });
    const second = await writeTaskReport(dir, 'artifacts', { summary: 'same', refs: ['a.txt'] });
    expect(second).toBe(first);
    expect(await readTaskReports(dir)).toHaveLength(1);
  });

  it.each([
    ['empty summary', { summary: '  ', refs: ['a.txt'] }],
    ['too many refs', { summary: 'ok', refs: Array.from({ length: 101 }, (_, i) => `f${i}.txt`) }],
    ['duplicate refs', { summary: 'ok', refs: ['a.txt', 'a.txt'] }],
    ['extra field', { summary: 'ok', refs: ['a.txt'], verdict: 'approved' }],
  ])('rejects an artifacts proposal with %s', async (_name, payload) => {
    await expect(writeTaskReport(inbox(), 'artifacts', payload)).rejects.toThrow('Invalid artifact proposal');
  });

  it.each([
    ['bad verdict', { verdict: 'ship-it', reason: 'ok', evidence: [] }],
    ['missing reason', { verdict: 'approved', evidence: [{ criterion: 0, note: 'a' }] }],
    ['duplicate criterion', { verdict: 'changes-requested', reason: 'ok', evidence: [{ criterion: 0, note: 'a' }, { criterion: 0, note: 'b' }] }],
    ['negative criterion', { verdict: 'changes-requested', reason: 'ok', evidence: [{ criterion: -1, note: 'a' }] }],
    ['empty note', { verdict: 'changes-requested', reason: 'ok', evidence: [{ criterion: 0, note: '' }] }],
  ])('rejects a review proposal with %s', async (_name, payload) => {
    await expect(writeTaskReport(inbox(), 'review', payload)).rejects.toThrow(/^Invalid review (proposal|evidence)$/);
  });

  it('keeps a second distinct payload as a poisoned operation for the owner to refuse', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'artifacts', { summary: 'first', refs: ['a.txt'] });
    await writeTaskReport(dir, 'artifacts', { summary: 'second', refs: ['a.txt'] });
    await expect(readSingleTaskReport(dir, 'artifacts')).rejects.toThrow('conflicting proposals');
  });

  it('requires an absolute inbox path', async () => {
    await expect(writeTaskReport('relative/inbox', 'artifacts', { summary: 'ok', refs: ['a'] })).rejects.toThrow('absolute');
  });
});

describe('readSingleTaskReport', () => {
  it('returns the one proposal of the expected kind', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'artifacts', { summary: 'only', refs: ['a.txt'] });
    await expect(readSingleTaskReport(dir, 'artifacts')).resolves.toEqual({ summary: 'only', refs: ['a.txt'] });
  });

  it('refuses an inbox without the expected proposal', async () => {
    const dir = inbox();
    await expect(readSingleTaskReport(dir, 'review')).rejects.toThrow('no review proposal');
  });

  it('refuses a receipt of a foreign kind', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'review', { verdict: 'approved', reason: 'foreign kind', evidence: [{ criterion: 0, note: 'a' }] });
    await expect(readSingleTaskReport(dir, 'artifacts')).rejects.toThrow('foreign proposal kind');
  });
});

describe('readTaskReports', () => {
  it('returns an empty list for a missing inbox', async () => {
    expect(await readTaskReports(join(inbox(), 'never-created'))).toEqual([]);
  });

  it('rejects foreign entries in an operation inbox', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'artifacts', { summary: 'ok', refs: ['a.txt'] });
    writeFileSync(join(dir, 'notes.txt'), 'not a receipt');
    await expect(readTaskReports(dir)).rejects.toThrow('unexpected entries');
  });

  it('rejects a receipt whose content does not match its digest name', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'artifacts', { summary: 'original', refs: ['a.txt'] });
    const [file] = readdirSync(dir).filter(name => name.startsWith('receipt-'));
    writeFileSync(join(dir, file), JSON.stringify({ version: 1, kind: 'artifacts', at: new Date().toISOString(),
      payload: { summary: 'tampered', refs: ['a.txt'] } }));
    await expect(readTaskReports(dir)).rejects.toThrow('Invalid task report receipt');
  });

  it('rejects a symlinked receipt', async () => {
    const dir = inbox();
    await writeTaskReport(dir, 'artifacts', { summary: 'ok', refs: ['a.txt'] });
    const outside = mkdtempSync(join(tmpdir(), 'task-report-out-')); roots.push(outside);
    const [file] = readdirSync(dir).filter(name => name.startsWith('receipt-'));
    renameSync(join(dir, file), join(outside, file));
    symlinkSync(join(outside, file), join(dir, file));
    await expect(readTaskReports(dir)).rejects.toThrow();
  });

  it('caps the inbox at 32 receipts', async () => {
    const dir = inbox();
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 33; index++) {
      writeFileSync(join(dir, `receipt-${`${index}`.padStart(64, '0')}.json`), 'x');
    }
    await expect(readTaskReports(dir)).rejects.toThrow('unexpected entries');
  });
});
