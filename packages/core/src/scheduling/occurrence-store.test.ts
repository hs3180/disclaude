/**
 * Tests for OccurrenceStore (Issue #5763): persistence, degradation, retention
 * and lifecycle boundaries. Isolated temp directories; injectable clock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OccurrenceStore, DEFAULT_OCCURRENCES_PER_TASK } from './occurrence-store.js';
import { occurrenceKey, reconcileStartup, type OccurrenceRecord } from './schedule-occurrence.js';

const NOW = new Date('2026-11-25T00:24:00Z');

function record(taskId: string, scheduledFor: string, overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord {
  return {
    taskId, scheduledFor, scheduledForLocal: scheduledFor, timezone: 'Asia/Shanghai', cron: '0 8 * * *',
    status: 'completed', delivery: 'sent', evidence: 'tick-path', observedAt: NOW.toISOString(), ...overrides,
  };
}

describe('OccurrenceStore', () => {
  let dir: string;
  beforeEach(async () => { dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'occ-store-')); });
  afterEach(async () => { await fsPromises.rm(dir, { recursive: true, force: true }); });

  it('round-trips records by identity and survives a fresh instance (restart)', async () => {
    const store = new OccurrenceStore({ dir, now: () => NOW });
    expect(await store.put(record('morning-report', '2026-11-25T00:00:00.000Z'))).toBe(true);
    expect(await store.get('morning-report', '2026-11-25T00:00:00.000Z')).toMatchObject({ status: 'completed', delivery: 'sent' });

    const restarted = new OccurrenceStore({ dir, now: () => NOW });
    expect((await restarted.all()).get(occurrenceKey('morning-report', '2026-11-25T00:00:00.000Z'))?.status).toBe('completed');
    expect(restarted.degraded).toBe(false);
  });

  it('is idempotent by identity: re-putting the same occurrence overwrites, never duplicates', async () => {
    const store = new OccurrenceStore({ dir, now: () => NOW });
    await store.put(record('t', '2026-11-25T00:00:00.000Z', { status: 'executing' }));
    await store.put(record('t', '2026-11-25T00:00:00.000Z', { status: 'completed' }));
    expect((await store.all()).size).toBe(1);
    expect((await store.get('t', '2026-11-25T00:00:00.000Z'))?.status).toBe('completed');
  });

  it('save failure: put reports false, keeps serving from memory, and flags degradation', async () => {
    // A regular file where the directory should be makes mkdir fail (EEXIST/ENOTDIR).
    const blocked = path.join(dir, 'blocked');
    await fsPromises.writeFile(blocked, 'not a dir', 'utf-8');
    const store = new OccurrenceStore({ dir: blocked, now: () => NOW });
    expect(await store.put(record('t', '2026-11-25T00:00:00.000Z'))).toBe(false);
    expect(store.degraded).toBe(true);
    expect((await store.get('t', '2026-11-25T00:00:00.000Z'))?.status).toBe('completed');
    expect(await store.recordStopped(NOW.toISOString())).toBe(false);
  });

  it('unreadable history: a corrupt file is set aside and its occurrences become unknown, not invented', async () => {
    const store = new OccurrenceStore({ dir, now: () => NOW });
    await store.put(record('good', '2026-11-25T00:00:00.000Z'));
    await fsPromises.writeFile(path.join(dir, 'bad.json'), '{ not json', 'utf-8');

    const restarted = new OccurrenceStore({ dir, now: () => NOW });
    const all = await restarted.all();
    expect(all.has(occurrenceKey('good', '2026-11-25T00:00:00.000Z'))).toBe(true);
    expect(all.has(occurrenceKey('bad', '2026-11-25T00:00:00.000Z'))).toBe(false);
    const files = await fsPromises.readdir(dir);
    expect(files).toContain('bad.json.corrupt');

    // Without a record and without stop evidence, reconciliation must not invent a result.
    const result = reconcileStartup({
      tasks: [{ id: 'bad', cron: '0 8 * * *', timezone: 'Asia/Shanghai', enabled: true }],
      evidence: { startedAt: NOW.toISOString() }, records: all, now: NOW,
    });
    expect(result.additions).toEqual([]);
    expect(result.gaps.map((g) => g.code)).toEqual(['no-stop-evidence']);
  });

  it('retention prunes expired records on load and on write; the per-task cap keeps the newest', async () => {
    const store = new OccurrenceStore({ dir, now: () => NOW, maxPerTask: 3 });
    const recent = ['2026-11-23T00:00:00.000Z', '2026-11-24T00:00:00.000Z', '2026-11-25T00:00:00.000Z'];
    for (const at of recent) { await store.put(record('t', at)); }
    await store.put(record('t', '2026-06-01T00:00:00.000Z')); // older than 90 days
    await store.put(record('t', '2026-11-22T00:00:00.000Z')); // 4th recent → oldest recent pruned

    const restarted = new OccurrenceStore({ dir, now: () => NOW, maxPerTask: 3 });
    const keys = [...(await restarted.all()).keys()].map((k) => k.split('@')[1]).sort();
    expect(keys).toEqual(['2026-11-23T00:00:00.000Z', '2026-11-24T00:00:00.000Z', '2026-11-25T00:00:00.000Z']);
    expect(DEFAULT_OCCURRENCES_PER_TASK).toBeGreaterThan(0);
  });

  it('lifecycle boundaries persist and feed the next start', async () => {
    const store = new OccurrenceStore({ dir, now: () => NOW });
    expect(await store.recordStarted('2026-11-24T23:00:00Z')).toBe(true);
    expect(await store.recordStopped('2026-11-24T23:01:00Z')).toBe(true);
    const restarted = new OccurrenceStore({ dir, now: () => NOW });
    expect(await restarted.getLifecycle()).toEqual({ startedAt: '2026-11-24T23:00:00Z', stoppedAt: '2026-11-24T23:01:00Z' });
  });
});
