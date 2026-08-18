import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorruptSnapshotError, FileIntentSnapshotStore } from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-orch-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClock() {
  let t = 1_000;
  return () => (t += 10);
}

/** Drive a full lifecycle so the persisted snapshot covers every region. */
async function driveFullLifecycle(store: FileIntentSnapshotStore, sessionId: string) {
  await store.createSessionAndPersist(sessionId);
  store.appendDraft(sessionId, 'hel');
  store.appendDraft(sessionId, 'book a flight', { utterance: 'book a flight' });
  store.promoteCandidate(sessionId, { utterance: 'book a flight', slots: { to: 'SFO' } });
  const canonical = store.freeze(sessionId);
  store.appendResult(sessionId, 'a1', 'running');
  store.appendResult(sessionId, 'a1', 'done', 'outline');
  store.markDelivered(sessionId);
  await store.drain();
  return canonical;
}

describe('FileIntentSnapshotStore — persistence', () => {
  it('persists one JSON file per session as the lifecycle advances', async () => {
    const store = new FileIntentSnapshotStore({ dir, now: fakeClock() });
    await store.ready;
    await driveFullLifecycle(store, 's1');

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['s1.json']);
  });

  it('reloads the full lifecycle across a restart', async () => {
    const first = new FileIntentSnapshotStore({ dir, now: fakeClock() });
    await first.ready;
    const canonical = await driveFullLifecycle(first, 's1');

    // "Restart": a fresh store over the same directory sees the same state.
    const second = new FileIntentSnapshotStore({ dir, now: fakeClock() });
    await second.ready;
    const snap = second.getSession('s1');
    expect(snap.phase).toBe('delivered');
    expect(snap.drafts.map((d) => d.text)).toEqual(['hel', 'book a flight']);
    expect(snap.candidate?.fields.slots?.to).toBe('SFO');
    expect(second.getCanonical('s1')).toEqual(canonical);
    expect(snap.results).toHaveLength(1);
    expect(snap.results[0]).toMatchObject({ agentId: 'a1', status: 'done', content: 'outline' });
  });

  it('continues draft seq numbering after a reload', async () => {
    const first = new FileIntentSnapshotStore({ dir });
    await first.ready;
    await first.createSessionAndPersist('s1');
    first.appendDraft('s1', 'one');
    first.appendDraft('s1', 'two');
    await first.drain();

    const second = new FileIntentSnapshotStore({ dir });
    await second.ready;
    // Restored session keeps counting from the last persisted draft.
    const d3 = second.appendDraft('s1', 'three');
    expect(d3.seq).toBe(3);
    await second.drain();
  });

  it('restores multiple sessions independently (barg-in sessions coexist)', async () => {
    const first = new FileIntentSnapshotStore({ dir, now: fakeClock() });
    await first.ready;
    await first.createSessionAndPersist('A');
    first.promoteCandidate('A', { utterance: 'task one' });
    first.freeze('A');
    await first.createSessionAndPersist('B');
    first.promoteCandidate('B', { utterance: 'task two' });
    first.freeze('B');
    await first.drain();

    const second = new FileIntentSnapshotStore({ dir });
    await second.ready;
    expect(second.getCanonical('A').fields.utterance).toBe('task one');
    expect(second.getCanonical('B').fields.utterance).toBe('task two');
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['A.json', 'B.json']);
  });

  it('persists every mutation — final on-disk state matches the last call, no .tmp leftovers', async () => {
    const store = new FileIntentSnapshotStore({ dir });
    await store.ready;
    await store.createSessionAndPersist('s1');
    store.appendDraft('s1', 'x');
    store.promoteCandidate('s1', { utterance: 'x' });
    store.freeze('s1');
    store.appendResult('s1', 'a1', 'running');
    store.appendResult('s1', 'a1', 'done', 'r');

    await store.drain();
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    const onDisk = JSON.parse(await readFile(join(dir, 's1.json'), 'utf8'));
    expect(onDisk.phase).toBe('frozen');
    expect(onDisk.results).toHaveLength(1);
    expect(onDisk.results[0]).toMatchObject({ agentId: 'a1', status: 'done', content: 'r' });
  });
});

describe('FileIntentSnapshotStore — failure modes', () => {
  it('throws CorruptSnapshotError for an undecodable session file', async () => {
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8');
    const store = new FileIntentSnapshotStore({ dir });
    await expect(store.ready).rejects.toThrow(CorruptSnapshotError);
  });

  it('ignores non-JSON files in the directory', async () => {
    await writeFile(join(dir, 'notes.txt'), 'ignore me', 'utf8');
    const store = new FileIntentSnapshotStore({ dir });
    await expect(store.ready).resolves.toBeUndefined();
  });

  it('refuses session ids that could escape the directory at creation time', async () => {
    const store = new FileIntentSnapshotStore({ dir });
    await store.ready;
    await expect(store.createSessionAndPersist('../evil')).rejects.toThrow(/unsafe sessionId/);
    await expect(store.createSessionAndPersist('a/b')).rejects.toThrow(/unsafe sessionId/);
    // Nothing was persisted for the rejected ids.
    await store.drain();
    expect(await readdir(dir)).toEqual([]);
  });

  it('flags a session file whose decoded id does not match its name', async () => {
    const forged = {
      sessionId: 'other',
      phase: 'drafting',
      drafts: [],
      candidate: null,
      canonical: null,
      results: [],
    };
    await writeFile(join(dir, 's1.json'), JSON.stringify(forged), 'utf8');
    const store = new FileIntentSnapshotStore({ dir });
    await expect(store.ready).rejects.toThrow(CorruptSnapshotError);
  });
});

describe('FileIntentSnapshotStore — inherits the in-memory contract', () => {
  it('keeps the single FREEZE point and immutability after a reload', async () => {
    const first = new FileIntentSnapshotStore({ dir });
    await first.ready;
    await first.createSessionAndPersist('s1');
    first.promoteCandidate('s1', { utterance: 'x' });
    first.freeze('s1');
    await first.drain();

    const second = new FileIntentSnapshotStore({ dir });
    await second.ready;
    expect(() => second.freeze('s1')).toThrow(/Invalid snapshot transition/);
    expect(() => second.appendDraft('s1', 'late')).toThrow(/Invalid snapshot transition/);
    // Results region stays writable until delivery.
    second.appendResult('s1', 'a1', 'done', 'r');
    second.markDelivered('s1');
    expect(() => second.appendResult('s1', 'a2', 'done')).toThrow(/Invalid snapshot transition/);
    await second.drain();
  });

  it('returns copies from a reloaded store, never internal references', async () => {
    const first = new FileIntentSnapshotStore({ dir });
    await first.ready;
    await first.createSessionAndPersist('s1');
    first.promoteCandidate('s1', { utterance: 'original' });
    first.freeze('s1');
    await first.drain();

    const second = new FileIntentSnapshotStore({ dir });
    await second.ready;
    const canonical = second.getCanonical('s1');
    canonical.fields.utterance = 'hacked';
    expect(second.getCanonical('s1').fields.utterance).toBe('original');
  });
});
