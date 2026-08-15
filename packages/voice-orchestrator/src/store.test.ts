import { describe, it, expect } from 'vitest';
import {
  IntentSnapshotStore,
  InvalidTransitionError,
  isAllowed,
  type SnapshotEvent,
  type SnapshotPhase,
} from './index.js';


/** Deterministic clock factory for stable timestamps in tests. */
function fakeClock() {
  let t = 1_000;
  return () => (t += 10);
}

describe('IntentSnapshotStore — lifecycle', () => {
  it('creates a session in the drafting phase', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    const snap = store.createSession('s1');
    expect(snap.phase).toBe('drafting');
    expect(snap.drafts).toEqual([]);
    expect(snap.canonical).toBeNull();
    expect(snap.results).toEqual([]);
  });

  it('refuses to create a duplicate session', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    expect(() => store.createSession('s1')).toThrow(/already exists/);
  });

  it('accumulates drafts with monotonic seq from the background stream', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('s1');
    const d1 = store.appendDraft('s1', 'hel');
    const d2 = store.appendDraft('s1', 'hello', { utterance: 'hello' });
    expect(d1.seq).toBe(1);
    expect(d2.seq).toBe(2);
    expect(store.getSession('s1').drafts).toHaveLength(2);
  });

  it('promotes a candidate at a turn boundary', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('s1');
    store.appendDraft('s1', 'book a flight');
    const c = store.promoteCandidate('s1', { utterance: 'book a flight', slots: { to: 'SFO' } });
    expect(c.fields.slots?.to).toBe('SFO');
    expect(store.getSession('s1').phase).toBe('candidate');
  });

  it('freezes the candidate into an immutable canonical', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'summarize the doc' });
    const canonical = store.freeze('s1');
    expect(canonical.fields.utterance).toBe('summarize the doc');
    expect(store.getSession('s1').phase).toBe('frozen');
    // getCanonical returns the frozen intent.
    expect(store.getCanonical('s1')).toEqual(canonical);
  });
});

describe('IntentSnapshotStore — single FREEZE point (design §4)', () => {
  it('throws when freezing an already-frozen session', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'x' });
    store.freeze('s1');
    expect(() => store.freeze('s1')).toThrow(InvalidTransitionError);
  });

  it('throws when reading canonical before freeze', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'x' });
    expect(() => store.getCanonical('s1')).toThrow(/not frozen/);
  });

  it('forbids appending drafts after freeze (intent is immutable)', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'x' });
    store.freeze('s1');
    expect(() => store.appendDraft('s1', 'more')).toThrow(InvalidTransitionError);
  });
});

describe('IntentSnapshotStore — results region (design §3)', () => {
  it('forbids results before freeze', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    expect(() => store.appendResult('s1', 'a1', 'done', 'r')).toThrow(InvalidTransitionError);
  });

  it('accepts results from multiple agents without mutating canonical', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'research X' });
    const canonical = store.freeze('s1');

    store.appendResult('s1', 'a1', 'done', 'outline');
    store.appendResult('s1', 'a2', 'running');

    const snap = store.getSession('s1');
    expect(snap.results.map((r) => r.agentId)).toEqual(['a1', 'a2']);
    // Canonical intent is untouched by the results region.
    expect(snap.canonical).toEqual(canonical);
    expect(store.getCanonical('s1')).toEqual(canonical);
  });

  it('merges updates to an existing agentId in place', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'x' });
    store.freeze('s1');

    store.appendResult('s1', 'a1', 'running');
    store.appendResult('s1', 'a1', 'done', 'final');

    const snap = store.getSession('s1');
    expect(snap.results).toHaveLength(1);
    expect(snap.results[0]).toMatchObject({ agentId: 'a1', status: 'done', content: 'final' });
  });

  it('marks delivered and then refuses further results', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'x' });
    store.freeze('s1');
    store.appendResult('s1', 'a1', 'done', 'r');
    store.markDelivered('s1');
    expect(store.getSession('s1').phase).toBe('delivered');
    expect(() => store.appendResult('s1', 'a2', 'done')).toThrow(InvalidTransitionError);
  });
});

describe('IntentSnapshotStore — barg-in keeps each canonical stable', () => {
  it('a barg-in session is independent; the prior canonical and its results persist', () => {
    // M0 acceptance: cross-minute / cross-barg-in delivery still matches the
    // same canonical. A new turn opens a fresh session; the old session's
    // canonical is unchanged and still accumulates its own results.
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('A');
    store.promoteCandidate('A', { utterance: 'task one' });
    const canonicalA = store.freeze('A');

    // barg-in: user starts a new turn → new session B
    store.createSession('B');
    store.promoteCandidate('B', { utterance: 'task two' });
    const canonicalB = store.freeze('B');

    // Each session's canonical is distinct and stable.
    expect(canonicalA.fields.utterance).toBe('task one');
    expect(canonicalB.fields.utterance).toBe('task two');
    expect(store.getCanonical('A')).toEqual(canonicalA);

    // In-flight results for A still land against A's region after the barg-in.
    store.appendResult('A', 'a1', 'done', 'result for task one');
    expect(store.getSession('A').results[0].content).toBe('result for task one');
    expect(store.getSession('B').results).toEqual([]);
  });
});

describe('state machine — pure transition table', () => {
  const cases: Array<{ from: SnapshotPhase; event: SnapshotEvent; ok: boolean }> = [
    { from: 'drafting', event: 'appendDraft', ok: true },
    { from: 'drafting', event: 'promoteCandidate', ok: true },
    { from: 'drafting', event: 'freeze', ok: false },
    { from: 'candidate', event: 'freeze', ok: true },
    { from: 'candidate', event: 'appendResult', ok: false },
    { from: 'frozen', event: 'appendResult', ok: true },
    { from: 'frozen', event: 'markDelivered', ok: true },
    { from: 'frozen', event: 'freeze', ok: false }, // single freeze point
    { from: 'frozen', event: 'appendDraft', ok: false }, // intent immutable
    { from: 'delivered', event: 'appendResult', ok: false },
  ];
  for (const { from, event, ok } of cases) {
    it(`${from} --${event}--> ${ok ? 'allowed' : 'rejected'}`, () => {
      expect(isAllowed(from, event)).toBe(ok);
    });
  }
});
