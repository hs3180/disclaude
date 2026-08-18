import { describe, it, expect } from 'vitest';
import { DeliveryGate } from './delivery-gate.js';
import { IntentSnapshotStore } from './store.js';

/** Deterministic clock factory: starts at t0, caller advances by hand. */
function controlledClock() {
  let t = 10_000;
  return { now: () => t, advance: (ms: number) => (t += ms), get: () => t };
}

/** Drive a store session to the frozen phase with one finished agent. */
function frozenSessionWithResult(store: IntentSnapshotStore, sessionId = 's1'): void {
  store.createSession(sessionId);
  store.appendDraft(sessionId, 'draft the weekly report');
  store.promoteCandidate(sessionId, { utterance: 'draft the weekly report' });
  store.freeze(sessionId);
  store.appendResult(sessionId, 'agent-1', 'done', 'outline ready');
}

describe('DeliveryGate — ETA discipline (mechanism ⑤)', () => {
  it('records the single ETA announce and returns its epoch-ms deadline', () => {
    const clock = controlledClock();
    const gate = new DeliveryGate({ store: new IntentSnapshotStore(), now: clock.now });
    expect(gate.setEta('s1', 30)).toBe(clock.get() + 30_000);
  });

  it('refuses a second ETA announce for the same session', () => {
    const gate = new DeliveryGate({ store: new IntentSnapshotStore() });
    gate.setEta('s1', 30);
    expect(() => gate.setEta('s1', 45)).toThrow(/already announced/);
  });

  it('rejects non-positive or non-finite etaSeconds', () => {
    const gate = new DeliveryGate({ store: new IntentSnapshotStore() });
    expect(() => gate.setEta('s1', 0)).toThrow(/positive finite/);
    expect(() => gate.setEta('s1', Number.NaN)).toThrow(/positive finite/);
    expect(() => gate.setEta('s1', Number.POSITIVE_INFINITY)).toThrow(/positive finite/);
  });

  it('evaluating an unknown session surfaces the store error', () => {
    const gate = new DeliveryGate({ store: new IntentSnapshotStore() });
    expect(() => gate.evaluate('nope')).toThrow(/Unknown session/);
  });
});

describe('DeliveryGate — delivery windows (mechanism ⑥)', () => {
  it('holds queued terminal results while no trigger fires', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    const d = gate.evaluate('s1');
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe('waiting');
    expect(d.results).toEqual([]);
  });

  it('delivers on a natural pause before the ETA lapses', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    clock.advance(5_000);
    const d = gate.evaluate('s1', { naturalPause: true });
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe('natural-pause');
    expect(d.results.map((r) => r.agentId)).toEqual(['agent-1']);
  });

  it('delivers once the self-reported ETA has elapsed, without any hint', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    clock.advance(30_000);
    const d = gate.evaluate('s1');
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe('eta-elapsed');
  });

  it('delivers on an explicit user ask even before the ETA elapses', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    const d = gate.evaluate('s1', { userAsked: true });
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe('user-asked');
  });

  it('prefers user-asked over eta-elapsed when both would open the window', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    clock.advance(60_000);
    const d = gate.evaluate('s1', { userAsked: true, naturalPause: true });
    expect(d.reason).toBe('user-asked');
  });

  it('delivers only terminal results — pending/running never leak (no progress stream)', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    store.appendResult('s1', 'agent-2', 'running');
    gate.setEta('s1', 30);
    const d = gate.evaluate('s1', { userAsked: true });
    expect(d.results.map((r) => r.status)).toEqual(['done']);
  });

  it('stays silent while everything is still in flight, even past the ETA', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    store.createSession('s2');
    store.appendDraft('s2', 'draft the weekly report');
    store.promoteCandidate('s2', { utterance: 'draft the weekly report' });
    store.freeze('s2');
    store.appendResult('s2', 'agent-1', 'running');
    gate.setEta('s2', 30);
    clock.advance(120_000);
    const d = gate.evaluate('s2', { naturalPause: true });
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe('nothing-ready');
  });

  it('keeps a delivered session closed', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    store.markDelivered('s1');
    const d = gate.evaluate('s1', { userAsked: true });
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe('nothing-ready');
  });

  it('treats an elapsed ETA as sticky across repeated evaluation (pure read)', () => {
    const clock = controlledClock();
    const store = new IntentSnapshotStore();
    const gate = new DeliveryGate({ store, now: clock.now });
    frozenSessionWithResult(store);
    gate.setEta('s1', 30);
    clock.advance(45_000);
    expect(gate.evaluate('s1').reason).toBe('eta-elapsed');
    expect(gate.evaluate('s1').reason).toBe('eta-elapsed');
    expect(store.getSession('s1').phase).toBe('frozen');
  });
});
