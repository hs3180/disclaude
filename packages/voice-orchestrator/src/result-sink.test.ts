import { describe, it, expect } from 'vitest';
import { IntentSnapshotStore } from './store.js';
import {
  InvalidResultStatusError,
  ResultAlreadySettledError,
  ResultSink,
} from './result-sink.js';
import type { Canonical, IntentFields } from './types.js';

/** Freeze helper: drafts → candidate → canonical, in one call. */
function frozenStore(sessionId: string, fields: IntentFields): IntentSnapshotStore {
  const store = new IntentSnapshotStore();
  store.createSession(sessionId);
  store.promoteCandidate(sessionId, fields);
  store.freeze(sessionId);
  return store;
}

describe('ResultSink — canonical read (design §4 单一冻结点)', () => {
  it('exposes the frozen canonical for the agent to read', () => {
    const store = frozenStore('s1', { utterance: 'research X', slots: { depth: 'deep' } });
    const sink = new ResultSink(store, 's1', 'a1');
    const canonical: Canonical = sink.getCanonical();
    expect(canonical.fields.utterance).toBe('research X');
    expect(canonical.fields.slots?.depth).toBe('deep');
  });

  it('returns a defensive copy — mutating it does not touch the store', () => {
    const store = frozenStore('s1', { utterance: 'original' });
    const sink = new ResultSink(store, 's1', 'a1');
    sink.getCanonical().fields.utterance = 'hacked';
    expect(sink.getCanonical().fields.utterance).toBe('original');
    expect(store.getCanonical('s1').fields.utterance).toBe('original');
  });

  it('reflects the session phase (frozen while work is in flight)', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    expect(sink.phase).toBe('frozen');
  });

  it('reading the canonical before freeze surfaces the store error', () => {
    const store = new IntentSnapshotStore();
    store.createSession('s1');
    const sink = new ResultSink(store, 's1', 'a1');
    expect(() => sink.getCanonical()).toThrow(/not frozen/);
  });
});

describe('ResultSink — results write-back (design §3 结果写回独立区)', () => {
  it('start claims a running row, complete settles it with content', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    expect(sink.getResult()).toBeNull();

    const started = sink.start();
    expect(started).toMatchObject({ agentId: 'a1', status: 'running' });
    expect(sink.getResult()?.status).toBe('running');

    const done = sink.complete('final answer');
    expect(done).toMatchObject({ agentId: 'a1', status: 'done', content: 'final answer' });
  });

  it('fail settles the row with an error message', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    sink.start();
    const failed = sink.fail('tool timeout');
    expect(failed).toMatchObject({ agentId: 'a1', status: 'error', error: 'tool timeout' });
  });

  it('results land in the session region without touching the canonical', () => {
    const store = frozenStore('s1', { utterance: 'intent' });
    const canonical = store.getCanonical('s1');
    const sink = new ResultSink(store, 's1', 'a1');
    sink.start();
    sink.complete('payload');
    expect(store.getSession('s1').results).toHaveLength(1);
    expect(store.getSession('s1').canonical).toEqual(canonical);
  });

  it('sinks for different agents are isolated rows in the same region', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const a = new ResultSink(store, 's1', 'a1');
    const b = new ResultSink(store, 's1', 'a2');
    a.start();
    a.complete('from a');
    b.start();
    b.fail('from b');
    const rows = store.getSession('s1').results;
    expect(rows.map((r) => r.agentId)).toEqual(['a1', 'a2']);
    expect(rows[0]).toMatchObject({ status: 'done', content: 'from a' });
    expect(rows[1]).toMatchObject({ status: 'error', error: 'from b' });
  });
});

describe('ResultSink — settlement is one-way', () => {
  it('complete after complete throws (history does not flip)', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    sink.start();
    sink.complete('final');
    expect(() => sink.complete('rewritten')).toThrow(ResultAlreadySettledError);
    expect(() => sink.fail('late failure')).toThrow(InvalidResultStatusError);
    expect(sink.getResult()).toMatchObject({ status: 'done', content: 'final' });
  });

  it('fail after fail throws; complete after fail throws', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    sink.start();
    sink.fail('boom');
    expect(() => sink.fail('boom again')).toThrow(ResultAlreadySettledError);
    expect(() => sink.complete('recovered')).toThrow(InvalidResultStatusError);
  });

  it('settle without start throws — a row must be claimed first', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    expect(() => sink.complete('no start')).toThrow(InvalidResultStatusError);
    expect(() => sink.fail('no start')).toThrow(InvalidResultStatusError);
    expect(sink.getResult()).toBeNull();
  });

  it('start after settle throws (done is terminal)', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    sink.start();
    sink.complete('done once');
    expect(() => sink.start()).toThrow(InvalidResultStatusError);
  });
});

describe('ResultSink — store guards pass through', () => {
  it('writing to a delivered session surfaces the state-machine error', () => {
    const store = frozenStore('s1', { utterance: 'x' });
    const sink = new ResultSink(store, 's1', 'a1');
    sink.start();
    store.markDelivered('s1');
    expect(() => sink.complete('late')).toThrow(/Invalid snapshot transition/);
  });

  it('a sink for an unknown session surfaces the store error', () => {
    const store = new IntentSnapshotStore();
    const sink = new ResultSink(store, 'nope', 'a1');
    expect(() => sink.start()).toThrow(/Unknown session/);
  });
});
