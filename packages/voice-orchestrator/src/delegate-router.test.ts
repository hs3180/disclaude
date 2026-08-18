import { describe, it, expect } from 'vitest';
import { DelegateRouter, EmptyTaskError, NotFreezableError } from './delegate-router.js';
import { IntentSnapshotStore } from './store.js';

function fakeClock() {
  let t = 1_000;
  return () => (t += 10);
}

/** Router over a drafting session with a couple of accumulated drafts. */
function draftingRouter() {
  const store = new IntentSnapshotStore({ now: fakeClock() });
  store.createSession('s1');
  store.appendDraft('s1', 'hel');
  store.appendDraft('s1', 'book a flight', { utterance: 'book a flight' });
  const ids = ['t1', 't2'];
  const router = new DelegateRouter(store, { newTaskId: () => ids.shift() ?? 't?' });
  return { store, router };
}

describe('DelegateRouter — delegate() as the FREEZE trigger', () => {
  it('freezes the delegated task as the canonical (single FREEZE point)', () => {
    const { store, router } = draftingRouter();
    const task = router.delegate('s1', { task: 'book a flight to SFO' });

    expect(task.taskId).toBe('t1');
    expect(task.canonical.fields.utterance).toBe('book a flight to SFO');
    expect(store.getSession('s1').phase).toBe('frozen');
    expect(store.getCanonical('s1')).toEqual(task.canonical);
  });

  it('carries the self-reported etaSeconds (mechanism ⑤) without freezing it into the snapshot', () => {
    const { store, router } = draftingRouter();
    const task = router.delegate('s1', { task: 'research x', etaSeconds: 90 });

    expect(task.etaSeconds).toBe(90);
    // ETA is routing bookkeeping, not intent — the snapshot stays lean.
    expect('etaSeconds' in (task.canonical as object)).toBe(false);
    expect(store.getCanonical('s1').fields).toEqual({ utterance: 'research x' });
  });

  it('omits etaSeconds when the LLM did not self-report one', () => {
    const { router } = draftingRouter();
    const task = router.delegate('s1', { task: 'quick thing' });
    expect(task.etaSeconds).toBeUndefined();
  });

  it('rejects an empty or whitespace-only task', () => {
    const { router } = draftingRouter();
    expect(() => router.delegate('s1', { task: '' })).toThrow(EmptyTaskError);
    expect(() => router.delegate('s1', { task: '   ' })).toThrow(EmptyTaskError);
  });

  it('refuses a second delegate on the same session (single freeze anchor)', () => {
    const { router } = draftingRouter();
    router.delegate('s1', { task: 'first' });
    expect(() => router.delegate('s1', { task: 'second' })).toThrow(NotFreezableError);
    expect(() => router.delegate('s1', { task: 'second' })).toThrow(/frozen/);
  });

  it('refuses delegate on a delivered session with the phase in the error', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('s1');
    store.promoteCandidate('s1', { utterance: 'done thing' });
    store.freeze('s1');
    store.markDelivered('s1');
    const router = new DelegateRouter(store);

    expect(() => router.delegate('s1', { task: 'another' })).toThrow(NotFreezableError);
    expect(() => router.delegate('s1', { task: 'another' })).toThrow(/delivered/);
  });

  it('hands out distinct task ids per call across sessions (delivery-queue index)', () => {
    const store = new IntentSnapshotStore({ now: fakeClock() });
    store.createSession('A');
    store.createSession('B');
    const router = new DelegateRouter(store, { newTaskId: () => `t${Math.random()}` });

    const a = router.delegate('A', { task: 'task one' });
    const b = router.delegate('B', { task: 'task two' });
    expect(a.taskId).not.toBe(b.taskId);
    expect(store.getCanonical('A').fields.utterance).toBe('task one');
    expect(store.getCanonical('B').fields.utterance).toBe('task two');
  });

  it('trims the task so surrounding whitespace never leaks into the frozen canonical', () => {
    const { router } = draftingRouter();
    const task = router.delegate('s1', { task: '  pad me  ' });
    expect(task.canonical.fields.utterance).toBe('pad me');
  });
});
